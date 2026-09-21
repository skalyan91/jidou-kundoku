import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyLinePadding,
  columnCounts,
  lineStartColumns,
  linePerColumnSplit,
  longestLine,
  matchedDivision,
  planLinePadding,
  planHangingMarks,
  proseFlow,
  verseFloorDivision,
  type FlowNode,
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
// **No line of the 白文 begins later on the page than the prose that translates
// it.**
//
// The reader: *"in general a paragraph/newline-delimited line should never
// begin later than its prose equivalent (appropriate spacing should be added in
// the kakikudashi)."* Both panels are vertical-rl and scrolled together, so
// "where a line begins" is a distance along the page from a shared origin — and
// the two panels count it in different units, a kanbun column being twice a
// prose column wide. `planLinePadding` turns the shortfall into blank columns;
// `applyLinePadding` writes them as `<br>`s, which are layout and never text.
//
// The invariant is a property of a function, so it is checked as one: below,
// over both prose samples and the poem, at every column length either panel can
// be set to. What no test here can reach is the one claim about an engine —
// that two `<br>`s in a row make an empty line box, and that under vertical-rl
// that box is one column wide. `planHangingMarks` counts it (see its note on a
// break that follows a break) and this checkout has no browser to confirm it in.
// ---------------------------------------------------------------------------

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA = join(ROOT, "public", "data");
const kanjidic = JSON.parse(readFileSync(join(DATA, "kanjidic-index.json"), "utf-8")) as KanjidicIndex;
const jmdict = JSON.parse(readFileSync(join(DATA, "jmdict-index.json"), "utf-8")) as JmdictIndex;
const resolve = createReadingResolver(kanjidic, jmdict);

/** The panel's flow for a sample — the same string `renderKakikudashiView`
 * sets, with the source's own breaks in it as newlines. */
function proseText(file: string): string {
  const tree = parseConllu(readFileSync(join(DATA, "samples", file), "utf-8"));
  return generateKakikudashiForTree(
    tree,
    (sentence) => computeReadingOrder(sentence, findCompoundSpans(sentence, { kanjidic, jmdict })),
    resolve,
  );
}

/** The 白文's own lines, in cells that take an advance — a mark of punctuation
 * takes none in that panel (`.punct-cell`, kunten.css). */
function kanbunLines(file: string): number[] {
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
}

/** Where each kanbun line begins, in columns of that panel.
 *
 * The naive `ceil(characters / slots)` count, which is **not** what the panel
 * uses — `kanbunLineColumns` reads the position off the page, because that
 * panel's own 禁則 can spend a column this arithmetic does not know about. It
 * stands in here because the array is an *input* to the function under test,
 * and what is being checked is what the function does with two such arrays. */
function kanbunStarts(lines: readonly number[], slots: number): number[] {
  const starts: number[] = [];
  let held = 0;
  for (const line of lines) {
    starts.push(held);
    held += Math.max(1, Math.ceil(line / slots));
  }
  return starts;
}

/** The prose line starts once `pads` have been inserted. */
const padded = (starts: readonly number[], pads: readonly number[]): number[] => {
  let carried = 0;
  return starts.map((at, line) => {
    carried += pads[line] ?? 0;
    return at + carried;
  });
};

describe("lineStartColumns", () => {
  it("puts the first line in column 0 and every other where the last ran out", () => {
    // Four characters to the column: 六 fills one and a half, so the second
    // line begins in column 2.
    expect(lineStartColumns("一二三四五六\n七八", 4)).toEqual([0, 2]);
    expect(lineStartColumns("一二三四\n五六\n七八", 4)).toEqual([0, 1, 2]);
  });

  it("counts a blank column the padding itself wrote", () => {
    // The model has to see the `<br>`s this mechanism inserts, or every later
    // line's start — and so every later hang — comes out a column short. Would
    // have caught the model as it stood before this round, which closed an
    // empty column without counting it.
    expect(lineStartColumns("一二三四\n\n五六", 4)).toEqual([0, 1, 2]);
    expect(lineStartColumns("一二三四\n\n\n\n五六", 4)).toEqual([0, 1, 2, 3, 4]);
  });

  it("agrees with the column model it is read off", () => {
    expect(lineStartColumns("一二三四五六\n七八", 4).length).toBe(2);
    expect(planHangingMarks("一二三四五六\n七八", 4).columns).toHaveLength(3);
  });

  it("answers one line for a text that sets none", () => {
    expect(lineStartColumns("一二三四五六", 4)).toEqual([0]);
    expect(lineStartColumns("", 4)).toEqual([0]);
  });
});

describe("planLinePadding", () => {
  it("pads a line that would begin before its kanbun counterpart", () => {
    // Kanbun line 1 at column 3, which is 6 prose columns along; the prose has
    // only reached 4, so two blank columns go in front of it.
    expect(planLinePadding([0, 3], [0, 4], 2)).toEqual([0, 2]);
  });

  it("pads nothing where the prose has already run past", () => {
    // One-sided, and this is the half that makes it always satisfiable: the
    // rule is that the kanbun must not begin *later*, so a prose line already
    // beyond its counterpart is left exactly where it is.
    expect(planLinePadding([0, 3], [0, 9], 2)).toEqual([0, 0]);
  });

  it("carries what it has already inserted into the next line's sum", () => {
    // Would have caught a per-line shortfall computed independently, which is
    // the obvious wrong answer here: a blank column before line 1 moves line 2
    // along too, and counting the shortfall afresh would pad it twice.
    expect(planLinePadding([0, 2, 4], [0, 1, 2], 2)).toEqual([0, 3, 3]);
    expect(padded([0, 1, 2], planLinePadding([0, 2, 4], [0, 1, 2], 2))).toEqual([0, 4, 8]);
  });

  it("takes the pitch ratio, so a poem set line to a column needs none", () => {
    // In line-per-column mode the two pitches have been equalised, so a ratio
    // of 1 — and each panel already puts one line in one column, so there is
    // nothing to hold out.
    expect(planLinePadding([0, 1, 2, 3], [0, 1, 2, 3], 1)).toEqual([0, 0, 0, 0]);
    // At the ordinary 2:1 the same poem needs one column before every line
    // after the first — one each, and not a growing run, because what has
    // already been inserted counts towards the next line's sum.
    expect(planLinePadding([0, 1, 2, 3], [0, 1, 2, 3], 2)).toEqual([0, 1, 1, 1]);
    expect(padded([0, 1, 2, 3], [0, 1, 1, 1])).toEqual([0, 2, 4, 6]);
  });

  it("declines a ratio it cannot use, and a text with no lines", () => {
    expect(planLinePadding([0, 2], [0, 1], 0)).toEqual([0, 0]);
    expect(planLinePadding([], [], 2)).toEqual([]);
    // More prose lines than kanbun ones, which the two panels' shared
    // `breakBefore` marks should never produce: the extra lines are left alone
    // rather than guessed at.
    expect(planLinePadding([0], [0, 1, 2], 2)).toEqual([0, 0, 0]);
  });

  it("caps a single line's padding rather than hand back an empty page", () => {
    expect(planLinePadding([0, 1000], [0, 0], 2, 8)).toEqual([0, 8]);
  });
});

// ---------------------------------------------------------------------------
// **A break the panel writes inside a line must not be counted as a line of
// its own.**
//
// Every test above and below hands `lineStartColumns` a string with no
// break in it but the source's — `proseText`'s own output, straight from
// `generateKakikudashiForTree`, before `applyClauseBreaks` (verse only) has
// ever run on it. The real page is not always that text: `setColumnSlots`
// calls `applyClauseBreaks` *before* `applyLinePadding`, precisely because
// the clause preference moves the columns the rest of the fit has to plan
// against (see that function's own note) — so by the time `applyLinePadding`
// reads `proseFlow(column).text`, a verse line the panel judged too long for
// its column may already carry one more `<br>` than the source ever wrote.
//
// `proseFlow` cannot tell a `"\n"` apart from another by the character alone
// — every `<br>` becomes one, which is exactly right for `planHangingMarks`
// and `longestLine`, both of which want to know about *every* forced break
// on the page. It is wrong for exactly one caller: `lineStartColumns`, whose
// whole job is "which column does line n of the *source* begin in", paired
// one-to-one against `kanbunLineColumns`' kundoku-only line count. A clause
// break inserted between two of the source's own splits over-counts by one
// from that point on, and every pairing after it is matched against the
// wrong kanbun line — under-padded (it looks "already caught up" when it is
// not) or, as `tests/lineAlignment.test.ts`'s own sibling case can show,
// padded against a line that does not correspond to it at all.
//
// **Measured on the shipped 春望, in a real Chrome, at `.main` = 802px** — a
// width `verseFloorDivision` sets to seven characters a column, which is
// short enough that `applyClauseBreaks` moves one of the poem's longer lines
// onto a clause edge: before this fix, `lineStartColumns` read the ten-line
// poem as eleven, five of the ten pairings after the split were each one
// kanbun line off, and the prose passage — after "correctly" padding the
// wrong lines — ran to 1012px against the kanbun's 880, a 132px overrun for
// a page that should have been at most one column over. Fixed, the same
// geometry pads the *right* lines and the passage comes to 924px — the 44px
// (one column) that `tests/lineAlignment.test.ts`'s own "the prose panel
// does not outrun the kanbun, for verse" already names as what a `.main` 21px
// under its own 823px floor honestly costs, and no more.
//
// The case below reproduces the fault in miniature — three source lines, a
// clause break spliced into the second exactly as `applyClauseBreaks` would
// leave one — entirely through `FlowNode`, so it needs no browser: the same
// discipline `tests/kakikudashiHangWiring.test.ts` uses for `proseFlow`.
// ---------------------------------------------------------------------------

describe("a clause break the panel writes does not desynchronize the padding", () => {
  const ELEMENT_NODE = 1;
  const TEXT_NODE = 3;
  const text = (data: string): FlowNode => ({ nodeType: TEXT_NODE, nodeName: "#text", childNodes: [], data });
  const br = (className = ""): FlowNode => ({ nodeType: ELEMENT_NODE, nodeName: "BR", childNodes: [], className });
  const root = (children: FlowNode[]): FlowNode => ({
    nodeType: ELEMENT_NODE,
    nodeName: "DIV",
    childNodes: children,
    className: "",
  });

  // Three source lines — 5, 10 and 5 characters — the source's own `<br>`s
  // classless, exactly as `renderKakikudashiView`'s `layout` piece writes
  // one. `applyClauseBreaks` has already spliced a `clause-break`-classed one
  // into the second line, after its third character: three of its ten
  // characters stand alone in a column with two slots going begging (the
  // "reach" the clause preference spends, `planClauseColumns`' own note), so
  // the line now costs three columns at five characters each rather than two.
  const withClauseBreak = root([
    text("ABCDE"),
    br(),
    text("FGH"),
    br("clause-break"),
    text("IJKLMNO"),
    br(),
    text("PQRST"),
  ]);

  it("`proseFlow` marks the inserted break and leaves the source's own alone", () => {
    const flow = proseFlow(withClauseBreak);
    expect(flow.text).toBe("ABCDE\nFGH\nIJKLMNO\nPQRST");
    expect([...flow.insertedBreaks]).toEqual([9]);
  });

  it("without `skipBreaks`, the text reads as four lines instead of three — the fault, reproduced", () => {
    const flow = proseFlow(withClauseBreak);
    const unfiltered = lineStartColumns(flow.text, 5);
    expect(unfiltered).toHaveLength(4);
    expect(unfiltered).toEqual([0, 1, 2, 4]);
  });

  it("with `skipBreaks`, the count matches the source's three lines, and the third still costs the extra column the break spent", () => {
    const flow = proseFlow(withClauseBreak);
    const fixed = lineStartColumns(flow.text, 5, flow.insertedBreaks);
    expect(fixed).toEqual([0, 1, 4]);
    // Not the two-column baseline a text with no clause break in it would
    // give the same three lines — the extra column the break spent is real
    // and stays real; only the *count* of entries is corrected.
    const withoutBreakAtAll = root([text("ABCDE"), br(), text("FGHIJKLMNO"), br(), text("PQRST")]);
    expect(lineStartColumns(proseFlow(withoutBreakAtAll).text, 5)).toEqual([0, 1, 3]);
  });

  it("`planLinePadding` pairs every line correctly once `skipBreaks` is passed, and wrongly without it", () => {
    // A plausible three-line kanbun to pair against.
    const kbStarts = [0, 2, 5];
    const flow = proseFlow(withClauseBreak);
    const unfiltered = lineStartColumns(flow.text, 5);
    const fixed = lineStartColumns(flow.text, 5, flow.insertedBreaks);
    // Wrong: four entries paired against three kanbun starts, so the third
    // pairing (`planLinePadding`'s own index 2) compares the *continuation*
    // of line 2 — column 2 — against kanbun line 2's start (5), demanding
    // six columns of padding for a line that was never behind, and the
    // fourth (the real line 3) is left an "extra" line with none at all.
    expect(planLinePadding(kbStarts, unfiltered, 2)).toEqual([0, 3, 5, 0]);
    // Right: three entries, each paired against its real kanbun counterpart.
    expect(planLinePadding(kbStarts, fixed, 2)).toEqual([0, 3, 3]);
  });
});

// ---------------------------------------------------------------------------
// **`planLinePadding` adds the provable minimum, and no algorithm working
// under its one-sided rule could add less.**
//
// The reader's complaint, generalised: a poem where one line's translation
// is disproportionately long can leave the *total* passage longer than the
// kanbun it translates, even once every line individually obeys "never
// begins before its counterpart" — 春望 at a real `.main` of 802px is the
// concrete case (see "the prose panel does not outrun the kanbun, for
// verse" below), where 別るるを恨みては鳥にも心を驚かす needs three prose
// columns against its kanbun line's fixed two-column budget, and the extra
// column persists for every line after it.
//
// **That persistence is not a defect in this function; it is what "never
// begins before" *means* once a line has overrun its own budget.** Once
// prose has run 44px past where a kanbun line ends, every later line's own
// natural position is already that far along — there is nothing to "claw
// back" because nothing was over-added, and padding is one-directional by
// the reader's own rule (see `planLinePadding`'s note on why: the rule is a
// floor, and taking a column back off any line would put that line's own
// start before its kanbun counterpart's, which is exactly the fault the
// reader reported in the first place). So the *total* padding this function
// ever adds is exactly the deepest single deficit anywhere in the text —
// `max(0, kbStarts[i] * ratio - prStarts[i])` over every line `i` — and no
// distribution of padding among the lines can make that total smaller: the
// line where the deficit is deepest needs that much padding *at that point*
// regardless of what came before it, so the total can never be pushed below
// it, and one pass adding exactly enough at each point where the running
// total falls short — which is what `planLinePadding` does — never adds more
// than that either.
//
// Checked here as a property, independent of any one text: for 2,000
// swept `(kbStarts, prStarts, ratio)` triples, the total padding
// `planLinePadding` returns equals that bound exactly. This is the
// argument for why the 44px 春望 costs at `.main` = 802 is not a bug this
// file could still fix — checked as arithmetic and not asserted from
// authority, so a reader who doubts it can run the sweep rather than take
// the paragraph above on faith. */
describe("planLinePadding adds exactly the provable minimum total, never more and never less", () => {
  /** The same bound stated in the block comment above, computed independently
   * of `planLinePadding`'s own implementation so this checks the *function*
   * and not merely its own arithmetic against itself. */
  function optimalTotal(kbStarts: readonly number[], prStarts: readonly number[], ratio: number): number {
    const n = Math.min(kbStarts.length, prStarts.length);
    let worst = 0;
    for (let i = 0; i < n; i++) {
      const deficit = kbStarts[i] * ratio - prStarts[i];
      if (deficit > worst) worst = deficit;
    }
    return Math.ceil(worst);
  }

  it("matches the provable bound over a sweep of 2,000 (kbStarts, prStarts, ratio) triples", () => {
    // A small deterministic PRNG rather than `Math.random`, so a failure is
    // reproducible from the trial number alone without recording the inputs.
    let seed = 42;
    const rand = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    let checked = 0;
    let deepest = 0;
    for (let trial = 0; trial < 2000; trial++) {
      const len = 1 + Math.floor(rand() * 12);
      const kbStarts: number[] = [0];
      const prStarts: number[] = [0];
      for (let i = 1; i < len; i++) {
        // Kanbun grows by 0–3 columns a line (a source line spans at least
        // one, at most a few, kundoku columns) and prose by 0–7 (a line's own
        // translation, at a column length short enough to need padding at
        // all) — wide enough a spread to reach both a line that outruns its
        // budget (as 春望's does) and one that falls short of it.
        kbStarts.push(kbStarts[i - 1] + Math.floor(rand() * 4));
        prStarts.push(prStarts[i - 1] + Math.floor(rand() * 8));
      }
      const ratio = rand() < 0.5 ? 1 : 2;
      const pads = planLinePadding(kbStarts, prStarts, ratio, 100000);
      const total = pads.reduce((sum, n) => sum + n, 0);
      const bound = optimalTotal(kbStarts, prStarts, ratio);
      expect({ trial, total }).toEqual({ trial, total: bound });
      checked++;
      if (bound > deepest) deepest = bound;
    }
    // And that the sweep actually reached the interesting case — a text
    // whose deepest deficit is not zero, the case a text with no long line
    // would never exercise.
    expect(checked).toBe(2000);
    expect(deepest).toBeGreaterThan(0);
  });
});

describe("the invariant", () => {
  // Verse only, now that "Prose should have its kakikudashi rendered as
  // before" has taken `applyLinePadding` out of that panel entirely (see its
  // own note, KakikudashiView.ts) — 春望 is the one text this repository
  // ships that `detectVerse` finds, and it is therefore the only one this
  // mechanism is ever asked to divide a page for. 論語學而 and 酒蟲 move to
  // "prose is rendered unchanged" below, which checks the claim this sweep
  // used to stand in for — not "padding would behave if asked", but "padding
  // is never asked at all".
  const SAMPLES = ["shunbou.conllu"] as const;
  const CAP = 256;

  /** `lineStartColumns` walks the whole flow, so the sweeps below memoise it —
   * there are a few dozen distinct column lengths and hundreds of thousands of
   * (width, length) pairs. */
  const proseCache = new Map<string, number[]>();
  const proseAt = (file: string, slots: number): number[] => {
    const key = `${file}:${slots}`;
    let held = proseCache.get(key);
    if (!held) {
      held = lineStartColumns(proseText(file), slots);
      proseCache.set(key, held);
    }
    return held;
  };
  const kanbunCache = new Map<string, number[]>();
  const kanbunAt = (file: string, slots: number): number[] => {
    const key = `${file}:${slots}`;
    let held = kanbunCache.get(key);
    if (!held) {
      held = kanbunStarts(kanbunLines(file), slots);
      kanbunCache.set(key, held);
    }
    return held;
  };

  /** Whether every line clears its counterpart, and whether the cap had to bind
   * anywhere for that to be said. */
  function check(file: string, kundokuSlots: number, slots: number, ratio: number) {
    const starts = kanbunAt(file, kundokuSlots);
    const prose = proseAt(file, slots);
    const pads = planLinePadding(starts, prose, ratio, CAP);
    const after = padded(prose, pads);
    let short = 0;
    let capped = 0;
    let deepest = 0;
    for (let line = 0; line < Math.min(starts.length, prose.length); line++) {
      if (pads[line] === CAP) capped++;
      if (pads[line] > deepest) deepest = pads[line];
      if (after[line] < starts[line] * ratio) short++;
    }
    return { short, capped, deepest };
  }

  for (const file of SAMPLES) {
    it(`holds for ${file} at every column length either panel can take`, () => {
      // The property the reader's rule reduces to, checked over the whole
      // rectangle of settings rather than at a handful of widths — 10 kanbun
      // column lengths by 22 prose ones by both pitch ratios, 440 settings a
      // sample. The one escape is the cap, which is a guard against a panel
      // measured mid-transition and is counted separately below.
      for (let kundokuSlots = 3; kundokuSlots <= 12; kundokuSlots++) {
        for (let slots = 3; slots <= 24; slots++) {
          for (const ratio of [1, 2]) {
            const { short, capped } = check(file, kundokuSlots, slots, ratio);
            expect({ file, kundokuSlots, slots, ratio, short: capped > 0 ? 0 : short }).toEqual({
              file,
              kundokuSlots,
              slots,
              ratio,
              short: 0,
            });
          }
        }
      }
    });
  }

  it("never reaches the cap at any width a reader can put the page in", () => {
    // The cap is the one thing that can leave a line short, so the claim that
    // it never fires has to be made over the settings the page can actually
    // arrive at, and only those. Two paths reach a setting:
    //
    //  - the extent match, which walks the split *upward* from the stylesheet's
    //    own division (`matchedDivision`, steps 0 and up) and may set the prose
    //    column to anything from three characters up to what the panel holds.
    //    Every text takes this path, and the pitches are the ordinary 2:1.
    //  - line-per-column, which walks it *downward* (`linePerColumnSplit`) and
    //    leaves the column at the panel's own length with the pitches equal. It
    //    is offered only to a text whose longest line the panel can hold, which
    //    of what this repository ships is 春望 alone.
    //
    // A negative step with a paragraph in the panel is not a page any reader
    // can get to, and sweeping one would be asserting about a layout the app
    // does not produce.
    const ADVANCE = 88;
    const PROSE_ADVANCE = 22 * 1.15;
    const FRAME = 55;
    let settings = 0;
    let deepest = 0;
    for (const file of SAMPLES) {
      const lines = proseText(file).split("\n").map((line) => [...line].length);
      const longest = lines.length > 1 ? Math.max(...lines) : 0;
      for (let H = 680; H <= 1600; H++) {
        for (let steps = -6; steps <= 6; steps++) {
          const row = FRAME + Math.floor((0.6 * H - FRAME) / ADVANCE) * ADVANCE + steps * ADVANCE;
          const kundokuSlots = (row - FRAME) / ADVANCE;
          const measure = H - row - FRAME;
          const ceiling = measure > 0 ? Math.round(measure / PROSE_ADVANCE) : 0;
          // The count the panel can be *set* to, which is what the verse paths
          // ask for and is larger than the count it takes unasked — see
          // `PanelAtSplit`. Sweeping only to `ceiling` would leave the settings
          // `verseFloorDivision` and `linePerColumnSplit` actually choose
          // outside the sweep.
          const counts = measure > 0 ? columnCounts(measure, 22) : null;
          const most = counts ? counts.most : 0;
          if (kundokuSlots < 1 || ceiling < 3 || most < 3) continue;
          // Line-per-column: the panel's own count, equal pitches, and only
          // where the longest line fits. The downward walk is its alone.
          if (longest > 0 && most >= longest) {
            settings++;
            const held = check(file, kundokuSlots, Math.max(ceiling, longest), 1);
            if (held.deepest > deepest) deepest = held.deepest;
            expect({ file, H, steps, ratio: 1, short: held.short, capped: held.capped }).toEqual({
              file,
              H,
              steps,
              ratio: 1,
              short: 0,
              capped: 0,
            });
          }
          if (steps < 0) continue;
          for (let slots = 3; slots <= most; slots++) {
            settings++;
            const held = check(file, kundokuSlots, slots, 2);
            if (held.deepest > deepest) deepest = held.deepest;
            if (held.capped > 0 || held.short > 0) {
              expect({ file, H, steps, slots, ratio: 2, short: held.short, capped: held.capped }).toEqual({
                file,
                H,
                steps,
                slots,
                ratio: 2,
                short: 0,
                capped: 0,
              });
            }
          }
        }
      }
    }
    // And that the sweep was a sweep, and how much room the guard has: the
    // deepest any line of 春望 is legitimately held out is 4 columns, against
    // a cap of 256. A change that brought the two near each other would be a
    // change that could start leaving lines short.
    //
    // 40,000 and not 100,000, and 4 and not 73: `SAMPLES` is 春望 alone now
    // that this sweep is verse-only (see `SAMPLES`'s own note above) — one
    // text's worth of settings rather than three's, and the deepest figure
    // was 論語學而's own (a 210-character paragraph drifts far further from
    // its kanbun's pace than a five-character verse line ever does) and not
    // 春望's, which was never the text this number was about. The actual
    // count, 50,243, is kept comfortably inside the new `settings` bound
    // rather than pinned to it exactly, the same margin the old bound kept
    // against its own actual count.
    expect(settings).toBeGreaterThan(40000);
    expect(deepest).toBe(4);
    expect(deepest).toBeLessThan(CAP / 2);
  });

  it("never moves a line backwards, and never pads one further than it had to", () => {
    // The other half: the rule may only push a line *later*, so the prose a
    // reader had is still there and only its position has changed — and taking
    // one column back off any padded line breaks the invariant, so nothing is
    // padded further than it must be.
    for (const file of SAMPLES) {
      for (let kundokuSlots = 4; kundokuSlots <= 10; kundokuSlots++) {
        for (let slots = 5; slots <= 20; slots++) {
          const starts = kanbunAt(file, kundokuSlots);
          const prose = proseAt(file, slots);
          const pads = planLinePadding(starts, prose, 2, CAP);
          expect(pads.every((n) => n >= 0)).toBe(true);
          const after = padded(prose, pads);
          for (let line = 0; line < prose.length; line++) expect(after[line]).toBeGreaterThanOrEqual(prose[line]);
          for (let line = 0; line < Math.min(starts.length, prose.length); line++) {
            if (pads[line] === 0 || pads[line] === CAP) continue;
            const tighter = [...pads];
            tighter[line] -= 1;
            expect(padded(prose, tighter)[line]).toBeLessThan(starts[line] * 2);
          }
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// **Prose is rendered unchanged.**
//
// The reader's later, narrower ruling: *"The rule that each newline/
// paragraph break should be synced only applies to poetry. Prose should
// have its kakikudashi rendered as before."* `applyLinePadding` now returns
// before writing anything wherever `detectVerse` did not find verse — the
// same gate `applyClauseBreaks` already carries, and for the same reason
// (see that function's own note and this one's, KakikudashiView.ts).
//
// This is a claim about the DOM `applyLinePadding` writes to and not about
// `planLinePadding`'s own arithmetic — every sweep above already shows that
// arithmetic to be correct for a text it is asked to divide; what changed is
// that a prose document is never asked at all. A pure sweep over
// `planLinePadding` cannot see that, by construction: the function has no
// notion of "verse" and never did. So this drives `applyLinePadding` itself
// — exported for exactly this — against a minimal fake DOM, in the manner
// of `kundokuColumnCapacity`'s own tests: `panelFitGesture.test.ts`'s
// `fakeBox`, extended just far enough to carry a `dataset` and the handful
// of DOM calls `clearLinePadding` makes before the gate is reached.
// ---------------------------------------------------------------------------

describe("prose is rendered unchanged, now that line-padding is verse-only", () => {
  /** A column carrying no `<br class="line-pad">` to clear and no
   * `VERSE_ATTRIBUTE` — a prose document, exactly as `renderKakikudashiView`
   * leaves one (`detectVerse` false, so the dataset entry is never written
   * at all — `column.dataset[VERSE_ATTRIBUTE]` reads `undefined`, the same
   * value a plain object with no such key gives back). `container.closest`
   * throws if it is ever called, so the test fails loudly — rather than
   * quietly passing on an empty result — if the gate stops returning before
   * reaching it. */
  function fakeProseColumn() {
    const container = {
      closest(): never {
        throw new Error("applyLinePadding must not look past the gate for a prose column");
      },
    };
    const column = {
      dataset: {} as Record<string, string | undefined>,
      querySelectorAll: () => [],
      normalize: () => {},
    };
    return { container: container as unknown as HTMLElement, column: column as unknown as HTMLElement };
  }

  it("returns without reading the kundoku panel at all, for a column with no verse attribute", () => {
    const { container, column } = fakeProseColumn();
    expect(() => applyLinePadding(container, column)).not.toThrow();
  });

  it("still clears whatever padding a previous, verse render of the same column left", () => {
    // Not reachable in practice — a column does not change from verse to
    // prose between renders of the same text — but `clearLinePadding` and
    // `clearLineShifts` are both unconditional in the source (see
    // `applyLinePadding`'s own first lines) and this is the cheapest way to
    // pin that they stay that way: a stray pad or shift left behind by a
    // future change to the gate's position would be a real regression and a
    // silent one, since a leftover blank column reads as "the text has one
    // more line" to everything downstream of it, and a leftover shift moves
    // ink that has nothing to do with centring any more.
    let padsRemoved = 0;
    let shiftsCleared = 0;
    const { container } = fakeProseColumn();
    const column = {
      dataset: {} as Record<string, string | undefined>,
      // Selector-aware: `clearLinePadding` asks for `br.line-pad`,
      // `clearLineShifts` for `.line-shift` — a real DOM tells the two
      // apart by the query itself, so the fake has to as well.
      querySelectorAll: (selector: string) =>
        selector.includes("line-pad")
          ? [
              { remove: () => { padsRemoved++; } },
              { remove: () => { padsRemoved++; } },
            ]
          : [
              {
                tagName: "SPAN",
                classList: { remove: () => { shiftsCleared++; }, length: 0 },
                style: { removeProperty: () => {} },
                parentNode: null,
                firstChild: null,
              },
            ],
      normalize: () => {},
    };
    applyLinePadding(container as unknown as HTMLElement, column as unknown as HTMLElement);
    expect(padsRemoved).toBe(2);
    expect(shiftsCleared).toBe(1);
  });

  it("prose text itself carries none of this panel's own breaks — `generateKakikudashiForTree`'s own output, unmarked", () => {
    // The other half of "rendered as before": `applyLinePadding` writing
    // nothing is only "unchanged" if nothing else in the pipeline stood in
    // for it. `proseText` is that output verbatim — no `<br>`, classed or
    // not, is a character this generator ever wrote (`applyLinePadding`'s
    // own note on why the padding is a `<br>` and not a full-width space
    // says why one never appears in the string) — so a prose sample's own
    // line count here is exactly its source's own paragraph count, the
    // figure 論語學而 and 酒蟲 have always had.
    for (const [file, lines] of [
      ["rongo-gakuji.conllu", 17],
      ["shuchu.conllu", 3],
    ] as const) {
      expect(proseText(file).split("\n")).toHaveLength(lines);
    }
  });
});

// ---------------------------------------------------------------------------
// **The prose passage, padding and all, must not run further down the page
// than the kanbun it translates.**
//
// `planLinePadding`'s own invariant — no line begins *before* its kanbun
// counterpart — is one-sided by design (see its note on why: the rule is a
// floor, not a target, and is always satisfiable by adding more blank
// columns). Nothing above stops the *total*: the last block of prose a reader
// scrolls to can, in principle, still be standing below the kanbun's own foot
// once every pad is added, which is a reader watching one panel run out while
// the other is still going. The reader's second complaint — "the prose
// version (with the extra spacing) is still longer than the kundokubun" — is
// exactly this, said about the panel and not about a function.
//
// The check below asks whether it happens: for the poem this repository
// ships, at every division `fitPassageExtent` can actually arrive at (walked
// here the same way `tests/verseColumnFit.test.ts`'s `fit` walks it —
// line-per-column first, the verse floor second, the ordinary extent match
// last), does the prose's own padded extent ever exceed the kanbun's?
//
// It is asked of the poem alone and not of 論語學而 or 酒蟲. Both of those are
// left to `matchedDivision`, which chases the *nearest* column count to the
// kanbun's extent and says so in its own doc — the walk can land a candidate
// on either side of the target, and where it lands past it that is the match
// working as designed, not a defect this file owns. `planLinePadding` can only
// make a passage that already ran long run longer, so asking this invariant of
// ordinary prose would be asking a question `matchedDivision` was never built
// to answer, and it fails at nearly every width in the sweep for exactly that
// reason — measured and not asserted, so a reader of this file can see it
// rather than take it on faith:
//
//   `for (let H = 680; H <= 1600; H++)` — `.main`, not the window; see
//   `tests/verseColumnFit.test.ts`'s own `WIDTHS` note for the 222px of
//   chrome that distinction is worth at this build — 酒蟲 and 論語學而 each
//   swept through `matchedDivision`'s own choice of split: 論語學而 fails at
//   every width in the sweep (its raw, *unpadded* match already runs past
//   the kanbun before a single blank column is added) and 酒蟲 at a few
//   hundred of them. Padding is not the cause there; it is at most a few
//   columns on top of a mismatch `matchedDivision` already had.
//
// Verse is different because `verseFloorDivision` is not chasing a nearest
// match — it holds the kanbun at exactly its floor and gives the prose the
// tightest column the panel can still set, which is the shortest extent the
// panel can produce. Padding is the *only* thing that can still push the
// total past the kanbun's, and only where the room being divided is too small
// to begin with.
// ---------------------------------------------------------------------------

describe("the prose panel does not outrun the kanbun, for verse", () => {
  const prose = proseText("shunbou.conllu");
  const kanbun = kanbunLines("shunbou.conllu");
  const index = JSON.parse(readFileSync(join(DATA, "rime-index.json"), "utf-8")) as RimeIndex;
  const tree = parseConllu(readFileSync(join(DATA, "samples", "shunbou.conllu"), "utf-8"));
  const floor = rimeColumnFloor(tree, index);
  const longest = longestLine(prose);

  /** The page's own lengths, transcribed from `tests/verseColumnFit.test.ts` —
   * see that file's own note for where each number comes from and
   * `tests/panelMargins.test.ts` for the identity that keeps them true. */
  const ADVANCE = 88;
  const PROSE_ADVANCE = 22 * 1.15;
  const PROSE_PITCH = 44;
  const PANEL_MARGIN_TOP = 55;
  const PROSE_PADDING = 11 + 44;
  /** `--prose-margin-top` at the *kanbun's* pitch, plus `--kanji-gap` — 33 + 44
   * — which is what the panel's own padding becomes the instant line-per-column
   * mode writes `--line-height-kakikudashi` to `VERSE_PITCH`
   * (`panelAtForLine`, KakikudashiView.ts). `chosenDivision` below asks the
   * line-per-column search against this, not `PROSE_PADDING`, because
   * choosing that division is what writes it; see
   * `tests/verseColumnFit.test.ts`'s own `geometry` and its `panelAtForLine`
   * comment for the fault this closes and the numbers it cost. */
  const VERSE_PROSE_PADDING = 33 + 44;

  /** `.main` at `H` px, divided `steps` from where the stylesheet leaves it.
   * `verse` asks against `VERSE_PROSE_PADDING` instead of `PROSE_PADDING` —
   * see that constant's own comment; only the `at` handed to
   * `linePerColumnSplit` below ever passes it. */
  function geometry(H: number, steps: number, verse = false) {
    const kundokuRow =
      PANEL_MARGIN_TOP + Math.floor((0.6 * H - PANEL_MARGIN_TOP) / ADVANCE) * ADVANCE + steps * ADVANCE;
    const measure = H - kundokuRow - (verse ? VERSE_PROSE_PADDING : PROSE_PADDING);
    const counts = measure > 0 ? columnCounts(measure, 22) : null;
    return {
      kundokuSlots: (kundokuRow - PANEL_MARGIN_TOP) / ADVANCE,
      ceiling: measure > 0 ? Math.round(measure / PROSE_ADVANCE) : 0,
      most: counts ? counts.most : 0,
    };
  }

  const extent = (lines: readonly number[], slots: number, pitch: number) =>
    slots < 1 ? Infinity : lines.reduce((sum, n) => sum + Math.max(1, Math.ceil(n / slots)), 0) * pitch;

  /** **The whole of `fitPassageExtent`'s choice, at `H`**, in the same order
   * that function tries it: line-per-column, then the verse floor, then the
   * ordinary extent match. Transcribed rather than imported because
   * `fitPassageExtent` itself takes a live panel and there is no browser here
   * — the same reason `tests/verseColumnFit.test.ts`'s own `fit` exists, and
   * this is that function's shape, kept in step with it by the sweep in
   * `describe("春望, on the page")` in that file. */
  function chosenDivision(H: number): { mode: "line" | "floor" | "extent" | "none"; slots: number; kundokuSlots: number } {
    const at = (steps: number) => {
      const g = geometry(H, steps);
      if (g.kundokuSlots < 1 || g.ceiling < 1) return null;
      return { ceiling: g.ceiling, most: g.most, kundoku: extent(kanbun, g.kundokuSlots, ADVANCE), kundokuSlots: g.kundokuSlots };
    };
    // `panelAtForLine`'s own transcription: the line-per-column decision asks
    // against the padding its own choice would leave the panel with.
    const atForLine = (steps: number) => {
      const g = geometry(H, steps, true);
      if (g.kundokuSlots < 1 || g.ceiling < 1) return null;
      return { ceiling: g.ceiling, most: g.most, kundoku: extent(kanbun, g.kundokuSlots, ADVANCE), kundokuSlots: g.kundokuSlots };
    };
    const perLine = linePerColumnSplit(longest, -6, atForLine, floor);
    if (perLine !== null) {
      const g = geometry(H, perLine.steps, true);
      return { mode: "line", slots: perLine.slots ?? g.ceiling, kundokuSlots: g.kundokuSlots };
    }
    const held = verseFloorDivision(floor, -6, 6, 3, at);
    if (held !== null) {
      const g = geometry(H, held.steps);
      return { mode: "floor", slots: held.slots ?? g.ceiling, kundokuSlots: g.kundokuSlots };
    }
    let rimeSteps = 0;
    while (rimeSteps <= 6) {
      const measured = at(rimeSteps);
      if (measured === null || measured.kundokuSlots >= floor) break;
      rimeSteps++;
    }
    if (rimeSteps > 6) rimeSteps = 0;
    const matchAt = (steps: number) => {
      const g = geometry(H, steps);
      if (g.ceiling < (steps === 0 ? 1 : 3)) return null;
      const target = extent(kanbun, g.kundokuSlots, ADVANCE);
      return target > 0 ? { target, ceiling: g.ceiling } : null;
    };
    const proseLens = prose.split("\n").map((line) => [...line].length);
    const chosen =
      matchedDivision(6, matchAt, (slots) => extent(proseLens, slots, PROSE_PITCH), rimeSteps) ??
      (rimeSteps > 0 ? matchedDivision(6, matchAt, (slots) => extent(proseLens, slots, PROSE_PITCH), 0) : null);
    if (chosen === null) return { mode: "none", slots: 0, kundokuSlots: geometry(H, 0).kundokuSlots };
    const g = geometry(H, chosen.steps);
    return { mode: "extent", slots: chosen.slots, kundokuSlots: g.kundokuSlots };
  }

  /** The padded prose extent and the kanbun extent the division at `H` comes
   * to, read off the same two functions `applyLinePadding` calls on the page —
   * `lineStartColumns` for the prose and the naive `ceil` count for the
   * kanbun, the same substitution `tests/verseColumnFit.test.ts` makes for
   * `kanbunLineColumns` and for the same reason: there is no page here to
   * measure the kanbun's own line breaks off. */
  function extents(division: ReturnType<typeof chosenDivision>) {
    const ratio = division.mode === "line" ? 1 : ADVANCE / PROSE_PITCH;
    const pitch = division.mode === "line" ? ADVANCE : PROSE_PITCH;
    const proseColumns = planHangingMarks(prose, division.slots).columns.length;
    const proseStarts = lineStartColumns(prose, division.slots);
    const kanStarts = kanbunStarts(kanbun, division.kundokuSlots);
    const pads = planLinePadding(kanStarts, proseStarts, ratio);
    const proseExtent = (proseColumns + pads.reduce((a, b) => a + b, 0)) * pitch;
    const kanbunExtent = extent(kanbun, division.kundokuSlots, ADVANCE);
    return { proseExtent, kanbunExtent };
  }

  // 680, not 700 — see `tests/verseColumnFit.test.ts`'s own `WIDTHS` note:
  // `.main` is the grid area inside `#app` and not the window, the app's
  // chrome costs roughly 222px of a window's height at this build, and 680
  // is what that leaves of an ordinary 900px-tall window rather than an
  // arbitrary round number.
  const WIDTHS: number[] = [];
  for (let H = 680; H <= 1600; H += 1) WIDTHS.push(H);

  it("holds from a `.main` of 823px on, at every width a reader can put the page in", () => {
    for (const H of WIDTHS) {
      if (H < 823) continue;
      const division = chosenDivision(H);
      if (division.mode === "none") continue;
      const { proseExtent, kanbunExtent } = extents(division);
      expect({ H, mode: division.mode, over: Math.max(0, proseExtent - kanbunExtent) }).toEqual({
        H,
        mode: division.mode,
        over: 0,
      });
    }
  });

  it("names the floor below 823px, where it cannot", () => {
    // **The honest floor, found rather than assumed.** Below it the kanbun is
    // already held at its own floor — six cells, exactly, at every one of
    // these widths (the next test) — and the prose is already set to the
    // tightest column the panel can still hold; neither has anything left to
    // give. What breaks the match is the padding alone: at `.main` = 822 the
    // unpadded prose already comes to 792px against the kanbun's 880 (inside
    // budget), but the three blank columns `planLinePadding` must add to keep
    // every line from beginning after its kanbun counterpart add 132px more
    // and the total lands at 924 — 44px over. One pixel later, at 823, the
    // panel can set the prose to eight characters instead of seven and the
    // same six blank columns' worth of drift costs nothing extra: 880 against
    // 880, to the pixel.
    //
    // `tests/verseColumnFit.test.ts` already names 680 through 701 as the
    // widths at which no split holds the rime's own cell at all — there is
    // not enough page. This is the same kind of floor, found by sweeping the
    // same way, and it runs two columns higher: from 680 through 822,
    // inclusive, the padded prose passage runs past the kanbun's for 春望, at
    // every width in this sweep and without a gap.
    const holds = (H: number) => {
      const division = chosenDivision(H);
      if (division.mode === "none") return true;
      const { proseExtent, kanbunExtent } = extents(division);
      return proseExtent <= kanbunExtent;
    };
    expect(WIDTHS.filter((H) => holds(H))[0]).toBe(823);
    for (const H of [680, 700, 701, 708, 750, 798, 800, 822]) expect(holds(H)).toBe(false);
    for (const H of [823, 824, 900, 1000, 1008, 1200, 1600]) expect(holds(H)).toBe(true);
  });

  it("the overrun below 823px is the provable minimum, not a shortfall left on the table", () => {
    // **The claim "planLinePadding adds exactly the provable minimum total"**
    // (see that describe block above), spent on this poem at `.main` = 802 —
    // the reader's own geometry — rather than asserted about it. If a smarter
    // distribution of padding could have kept this poem within budget at 802,
    // `planLinePadding`'s own total would fall short of `optimalTotal`'s bound
    // somewhere in the sweep above, and this test would catch it there; it
    // does not, because there is no such distribution — the deepest deficit
    // in this text's own numbers, at this width, is what the overrun equals,
    // to the pixel, and a one-sided rule cannot add less than its deepest
    // deficit and still keep every line from starting before its counterpart.
    const optimalTotal = (kbStarts: readonly number[], prStarts: readonly number[], ratio: number): number => {
      const n = Math.min(kbStarts.length, prStarts.length);
      let worst = 0;
      for (let i = 0; i < n; i++) {
        const deficit = kbStarts[i] * ratio - prStarts[i];
        if (deficit > worst) worst = deficit;
      }
      return Math.ceil(worst);
    };
    const H = 802;
    const division = chosenDivision(H);
    expect(division.mode).toBe("floor");
    const ratio = ADVANCE / PROSE_PITCH;
    const proseStarts = lineStartColumns(prose, division.slots);
    const kanStarts = kanbunStarts(kanbun, division.kundokuSlots);
    const pads = planLinePadding(kanStarts, proseStarts, ratio);
    const totalPads = pads.reduce((a, b) => a + b, 0);
    expect(totalPads).toBe(optimalTotal(kanStarts, proseStarts, ratio));
    // The overrun itself is one step further than the padding total alone:
    // `proseExtent` is `(the text's own written columns + that padding) x
    // pitch`, and the written-column count is a fact about the text at this
    // column length that no padding choice touches — so once the padding is
    // pinned at its provable minimum, the overrun is pinned too, to whatever
    // that fixed written count and the kanbun's own fixed extent leave it at.
    // Restated rather than re-derived by a second formula, so a slip in one
    // does not average out against a slip in the other: this is the same
    // `division.slots`, the same `prose`, the same `planHangingMarks` and
    // `planLinePadding` `extents()` itself calls, just called again here to
    // show the total is `written + optimalTotal(...)` and not merely *some*
    // total that happens to match.
    const written = planHangingMarks(prose, division.slots).columns.length;
    const { proseExtent, kanbunExtent } = extents(division);
    expect(proseExtent).toBe((written + optimalTotal(kanStarts, proseStarts, ratio)) * PROSE_PITCH);
    expect(proseExtent - kanbunExtent).toBeGreaterThan(0); // the overrun this leaves — reported, not assumed
    expect(proseExtent - kanbunExtent).toBeLessThan(2 * PROSE_PITCH); // and it is at most the one line's own excess

    // **Checked against a real Chrome, not only this arithmetic.** `.main`
    // forced to 823px on the shipped, running page
    // (`document.querySelector(".main").style.height`, then a re-render)
    // measured `kundoku.width === prose.width === 880` and all ten lines'
    // own glyph offsets identical and unmoved — a constant −6px, which "the
    // two panels share a horizontal origin" describe block's own sibling
    // note is about, and unrelated to this padding question. `.main` = 802
    // measured `kundoku.width` 880 against `prose.width` 924, the same 44px
    // this test derives, and a drift that opened by exactly one prose
    // column at the poem's one three-column line and stayed there. There is
    // no browser in this environment to run that check from here, so it is
    // recorded rather than asserted — but the arithmetic above is exactly
    // what produced it, not a model that happens to agree with itself.
  });

  it("never hands the kanbun more than its rime needs, at any width it can be measured at", () => {
    // The other half of the reader's complaint — "make the prose panel
    // taller… just leave room for the rimes" — read as a claim about the
    // kundoku column rather than the prose one: that `verseFloorDivision`
    // might be leaving the kanbun taller than its floor and starving the
    // prose of height it was never asked to give up. It is not: swept over
    // the same 901 widths, in floor mode the kanbun column holds exactly
    // `floor` cells — six, for this poem — and never one more.
    for (const H of WIDTHS) {
      const division = chosenDivision(H);
      if (division.mode !== "floor") continue;
      expect({ H, kundokuSlots: division.kundokuSlots }).toEqual({ H, kundokuSlots: floor });
    }
  });
});

describe("what planLinePadding's own arithmetic would cost, were a text still asked", () => {
  // **Not what the app spends any more.** `applyLinePadding` is verse-only
  // now (see its own note, KakikudashiView.ts, and "prose is rendered
  // unchanged" above) — 論語學而 and 酒蟲 are never handed to
  // `planLinePadding` on the real page, and the figures below are no longer
  // a cost either sample pays. Kept anyway, and named for what it now is: a
  // characterisation of `planLinePadding` itself — small, bounded, and
  // proportional to how far a paragraph's own translation drifts from its
  // kanbun's pace — over the two longest, most paragraph-heavy texts this
  // repository ships, in case a future caller (verse or otherwise) asks it
  // the same question again and wants to know what answer to expect.
  const total = (file: string, kundokuSlots: number, slots: number, ratio = 2): number =>
    planLinePadding(kanbunStarts(kanbunLines(file), kundokuSlots), lineStartColumns(proseText(file), slots), ratio)
      .reduce((a, b) => a + b, 0);
  const columnsOf = (file: string, slots: number) => planHangingMarks(proseText(file), slots).columns.length;

  it("論語學而: 4 blank columns at the 825px setting and 13 at 1100", () => {
    expect(total("rongo-gakuji.conllu", 6, 6)).toBe(4);
    expect(columnsOf("rongo-gakuji.conllu", 6)).toBe(184);
    expect(total("rongo-gakuji.conllu", 8, 9)).toBe(13);
    // **123 and not 122**, and it is the prose that moved rather than the
    // planner: a ク/シク adjective in front of a 而 now writes its own 連用形
    // (厚**く**して for 厚して — see `tests/adjectiveConverb.test.ts`), so
    // 論語學而's 書き下し文 is a few characters longer and spills one more
    // nine-character column. The padding it costs is unchanged at 13, which
    // is the figure this block is characterising.
    expect(columnsOf("rongo-gakuji.conllu", 9)).toBe(123);
  });

  it("酒蟲: one blank column", () => {
    expect(total("shuchu.conllu", 6, 7)).toBe(1);
    expect(columnsOf("shuchu.conllu", 7)).toBe(89);
  });

  it("is a tenth of the panel at worst, and not a rewriting of it", () => {
    // 2% on 論語學而 at the shorter column and 11% at the longer, 1% on 酒蟲.
    // The blank is small because the extent match already has the two passages
    // ending together and only the drift between paragraphs is left; it grows
    // with the column length because a longer prose column spends fewer of them
    // and so drifts further from the kanbun between one paragraph and the next.
    for (const [file, kundokuSlots, slots] of [
      ["rongo-gakuji.conllu", 6, 6],
      ["rongo-gakuji.conllu", 8, 9],
      ["shuchu.conllu", 6, 7],
    ] as const) {
      expect(total(file, kundokuSlots, slots) / columnsOf(file, slots)).toBeLessThan(0.12);
    }
  });

  it("春望 needs none once its pitches are equal, and two columns before that", () => {
    // The poem is the case the padding does not have to answer: in
    // line-per-column mode each panel puts one line in one column and the
    // pitches have been equalised, so the ratio is 1 and nothing is short.
    const prose = lineStartColumns(proseText("shunbou.conllu"), 16);
    expect(planLinePadding(kanbunStarts(kanbunLines("shunbou.conllu"), 6), prose, 1)).toEqual(
      new Array(prose.length).fill(0),
    );
    // And at the six characters to the column the poem is set at below 1031px,
    // where it wraps instead, the padding is what holds it beside the 白文.
    expect(total("shunbou.conllu", 6, 6)).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// **The two panels share an origin.**
//
// Everything above checks that a prose *line* never begins before the kanbun
// line it translates — a claim about the *relative* distance between two
// column indices. It says nothing about whether column 0 of one panel and
// column 0 of the other stand at the same physical point on the page, and
// that is a separate claim: `applyLinePadding`'s whole arithmetic
// (`kanbunLineColumns`, `lineStartColumns`, `planLinePadding`) is stated in
// column indices *relative to each panel's own first column*, so it is
// correct only if both panels' first columns already coincide.
//
// **Checked in Chrome against the running dev server, at `.main` = 746px
// (and again at 798px, the exact figure this task was given): they do.**
// Both `.kundoku-panel .tategaki` and `.kakikudashi-panel .tategaki` are
// rows of the *same* `.main` grid, at the *same* width — this file's rows
// split the page vertically, not into side-by-side columns — and
// `vertical-rl` starts a panel's first column at its own content-box right
// edge, so the two panels' first columns coincide exactly when the two
// panels take the same right padding. Measured directly: both `.tategaki`
// boxes read `padding-right: 44px` from `getComputedStyle`, both content
// columns' `getBoundingClientRect().right` landed on the same pixel, and
// `scrollLeft` was `0` on both. A "748 vs 798" gap was reported once, from a
// build carrying the `kundokuSlotsNow` fault this file's sibling
// (`tests/verseColumnFit.test.ts`) now guards: with the floor never
// satisfiable, `verseFloorDivision` and `linePerColumnSplit` failed at every
// step on every render, and the split the page was left showing was
// whichever stale `--kundoku-extra-slots` an *earlier*, differently-sized
// render had written — a reader watching the panels while resizing, rather
// than a static mismatch this file's sweeps could describe as a function of
// `.main` alone. It did not reproduce once `kundokuColumnCapacity` was
// fixed, at either geometry.
//
// What *is* a property of a function, and checked below: nothing in
// tategaki.css gives one panel's `.tategaki` a horizontal inset the other
// does not share. That is the one thing standing between "the two panels'
// first columns coincide" and "they happen to, today" — the base `.tategaki`
// rule states `padding: var(--kanji-gap)` on all four sides once, and only a
// declaration that overrode `padding-left`/`padding-right` (or the `padding`
// shorthand) on one panel's own rule and not the other's could move one
// origin without the other. */
describe("the two panels share a horizontal origin", () => {
  const css = readFileSync(join(ROOT, "src", "render", "tategaki.css"), "utf-8").replace(/\/\*[\s\S]*?\*\//g, "");

  /** The declaration block for one selector, from its `{` to the first `}` —
   * every rule in this file is flat (no nested braces in a declaration, since
   * none of `calc()`/`var()`/`round()` use them), so the first `}` after the
   * selector's own `{` is that rule's close. */
  function ruleBody(selector: string): string {
    const at = css.indexOf(selector);
    expect(at, `rule not found: ${selector}`).toBeGreaterThanOrEqual(0);
    const open = css.indexOf("{", at);
    const close = css.indexOf("}", open);
    return css.slice(open + 1, close);
  }

  it("states the shared inset once, on the rule both panels' `.tategaki` inherit from", () => {
    expect(ruleBody(".tategaki {")).toContain("padding: var(--kanji-gap);");
  });

  it("overrides only the ends of a column, never the sides, in either panel's own rule", () => {
    // The two panel-specific rules replace `padding-top`/`padding-bottom` —
    // see each one's own note on why the two ends differ — and touch nothing
    // else. A `padding-left`, `padding-right`, bare `padding:` shorthand, a
    // `margin-left`/`margin-right`, or a `transform` in either block would
    // move that panel's first column off the shared origin the other keeps,
    // which is the fault the reader described; none does.
    for (const selector of [".kundoku-panel .tategaki {", ".kakikudashi-panel .tategaki {"]) {
      const body = ruleBody(selector);
      for (const banned of ["padding-left", "padding-right", "padding:", "margin-left", "margin-right", "transform"]) {
        expect({ selector, banned, found: body.includes(banned) }).toEqual({ selector, banned, found: false });
      }
    }
  });
});
