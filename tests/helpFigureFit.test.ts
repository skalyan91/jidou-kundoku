import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deprelRowsShown, posMenuWords, READING_MENU_GROUPS, SAMPLE } from "../src/render/HelpModal.ts";
import { syntacticPrefix } from "../src/parse/xpos.ts";
import {
  MENU_JOIN_GAP,
  menuAnchorFor,
  type Extent,
  type RetagKind,
} from "../src/render/tokenInspector.ts";

/** **Do the tutorial's eight figures fit inside their own boxes?**
 *
 * The help modal draws its figures out of the app's own parts — a real sample
 * column, a real retag menu, a real pointer — and lays them out inside a
 * 20rem grid column that is sized *from* them (`.help-steps`, `.help-modal`).
 * The figures used to set no `overflow` at all, so one that outgrew its column
 * was not clipped: it spilled, into the neighbouring column, the dialog's
 * padding, or under the sticky header. That happened twice, and both times it
 * happened silently — because the arithmetic that says a figure fits lived in
 * a stylesheet comment, and a comment does not fail.
 *
 * They are clamped now — one declared height for all eight and `overflow:
 * hidden` — which changes what a miss *looks* like and not whether it is one. A
 * figure that asks for more than its box no longer spills; it is cut, silently,
 * and the reader is shown a figure with a piece missing rather than a dialog
 * with a figure across it. So this file asserts two things of the clamp on top
 * of the fit it always asserted: that every figure really is the same size, and
 * that the clamp is deep enough to leave each of them showing something a
 * reader can use — for the one figure it genuinely cuts, that it is cut between
 * words rather than through one.
 *
 * The last one is what this file is for. The retag menu was rebuilt on a 20px
 * grid: an entry's padding went from 0.35rem to a 二分 and the gutter between
 * two columns from 5.6px to 10, which took the part-of-speech menu from four
 * columns to five and from 163.2px to 202 — and the figure holding it beside
 * an 88px column with a 2rem gutter went from 283.2 to 322, past the 320px
 * column outright. Nothing in kunten.css knew that a tutorial figure was
 * measured against it. This file is that knowledge, written where a change to
 * either stylesheet has to walk past it.
 *
 * ── What it can and cannot say ───────────────────────────────────────────
 * There is no browser in this suite, so nothing here is a measurement. Every
 * figure below is arithmetic off the declarations, and the declarations are
 * *read out of the stylesheets* rather than restated, so that moving one is
 * what makes this fail. What it computes is the width of the ink a figure
 * lays down: its flex children and the gaps between them, plus the two things
 * painted outside those boxes — a relation label hanging into a gutter, and
 * the pointer, which hangs off whatever it points at.
 *
 * Three figures in it are not arithmetic and are named where they are used:
 *
 *   - the **31px** a relation label and its arc reach past the left edge of
 *     the sample they are drawn on, which is a measurement recorded at
 *     `.help-figure-menu-gutter` (app.css) from a round that had a browser;
 *   - the **flush inset** the part-of-speech figure spends on joining its
 *     menu to the pill (`joinMenuToPill`), which is measured off the laid-out
 *     figure — so that one is bounded here rather than valued, by the one
 *     thing that is true of it whatever the pill's width: it cannot exceed
 *     half a column;
 *   - the **viewport ceiling** in `sizeMenuSquarish`'s clamp, which is
 *     dropped from the model below. It is `0.88 · innerHeight − extra`, and
 *     the tallest menu here is a 226.6px table; it would take a window under
 *     276px tall to bind, and the dialog it sits in is `88vh` and scrolls.
 *
 * ── Across the page and down it ──────────────────────────────────────────
 * Both, now. This file began as a width test, because both of the spills it
 * was written after were sideways; the third report was that the
 * part-of-speech figure was *tall*, and nothing here counted a pixel of that.
 * So each figure below carries an `ink` measured across the page and a
 * `natural` height measured down it, and both are asserted — the first against
 * the column, the second against the clamp.
 *
 * The height model is one line longer than the width one. Seven of the eight
 * figures are a sample and something beside it, and the sample is the taller
 * of the two whatever the something is, so their height is the sample's plus
 * the figure's own padding and border. The eighth is stacked
 * (`.help-figure-menu-below`), so its height is a *sum* — the sample, the gap
 * between them, and the menu's inline extent, which is the same
 * `sizeMenuSquarish` arithmetic the widths are made of, read along the run
 * instead of across it. It is `natural` and not `height` because no figure's
 * box is its contents any more: what a figure comes to on its own is what
 * decides whether the clamp holds it open or cuts it short.
 *
 * Two deliberate slacknesses, both in the safe direction:
 *
 *   - every figure is given the **taller** of the two sample heights, the 352
 *     of a sample whose trailing gap houses a part-of-speech chip rather than
 *     the 308 of one with nothing to house (`.help-sample`, app.css). Which of
 *     the two a figure gets is a fact about where its arrow ran and is decided
 *     from the laid-out figure by `keepFootGap`, which is not a thing this file
 *     can ask. An upper bound is enough for a test that asserts a ceiling.
 *   - the menu's extent is taken as `sizeMenuSquarish`'s **cap**, where the
 *     real table is as tall as its tallest *column*. `shrinkMenuToContent`
 *     pulls the cap down to exactly that afterwards, so the cap is an upper
 *     bound too. On the part-of-speech menu the two part company for the first
 *     time — a 211 cap over columns whose tallest is 200 — so that figure's
 *     619 is 11px above what it really comes to. It is 108 over the clamp
 *     either way, and the clamp arithmetic does not touch it: what the clip
 *     shows is measured *down from the top of the run*, so it depends on the
 *     packing and not on where the table ends.
 *
 * What no arithmetic here can settle is what any of it looks like. */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const app = readFileSync(join(ROOT, "src", "app.css"), "utf-8");
const kunten = readFileSync(join(ROOT, "src", "render", "kunten.css"), "utf-8");
const typography = readFileSync(join(ROOT, "src", "render", "typography.css"), "utf-8");

/** The root font size every `rem` in these files resolves against. Nothing in
 * the app sets one, so it is the UA's, and 16 is what every engine ships —
 * the same constant, for the same reason, as tests/rereadLane.test.ts. */
const REM = 16;

const withoutComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");

/** The body of the first top-level rule with exactly this selector, optionally
 * the first whose body contains `contains` — the same reader the other
 * stylesheet tests use, anchored at the start of a line so that a selector
 * that is a substring of a longer one cannot answer for it. */
function ruleBody(css: string, selector: string, contains?: string): string {
  const text = withoutComments(css);
  const head = new RegExp(`^${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{`, "gm");
  for (let m = head.exec(text); m !== null; m = head.exec(text)) {
    const open = text.indexOf("{", m.index);
    let depth = 0;
    for (let i = open; i < text.length; i++) {
      if (text[i] === "{") depth++;
      else if (text[i] === "}" && --depth === 0) {
        const body = text.slice(open + 1, i);
        if (contains === undefined || body.includes(contains)) return body;
        break;
      }
    }
  }
  throw new Error(`no rule for ${selector}${contains ? ` containing ${contains}` : ""}`);
}

/** Every declaration in a rule body, last one winning, as the cascade has it. */
function declarations(body: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const [, name, value] of body.matchAll(/(--?[a-z-]+|[a-z-]+)\s*:\s*([^;]+);/g)) {
    out.set(name.trim(), value.replace(/\s+/g, " ").trim());
  }
  return out;
}

/** The type scale, off `:root` in typography.css — where `--column-pitch` and
 * the rest of the kundoku geometry is declared. */
const TYPE = declarations(ruleBody(typography, ":root", "--column-pitch"));

/** One CSS length in pixels, in the vocabulary these declarations are written
 * in: `var()` with its fallback, `calc()`, `max()`, `min()`, and lengths in
 * `px`, `rem` and `em`. `em` is the font size of the element the declaration
 * is on, which every caller below has to supply because the menu deliberately
 * sets three of them (the entries', the heading's, and `--menu-cell`, which is
 * the entries' em carried down as a length — see `.token-context-menu`). */
function lengthOf(expr: string, { em = 0, vars = {} as Record<string, string> } = {}): number {
  const lookup = (name: string) => vars[name] ?? TYPE.get(name);
  let text = expr;
  for (let round = 0; text.includes("var("); round++) {
    if (round > 20) throw new Error(`var() cycle in ${expr}`);
    text = rewriteCalls(text, "var", ([name, fallback]) => {
      const value = lookup(name);
      if (value !== undefined) return `(${value})`;
      if (fallback !== undefined) return `(${fallback})`;
      throw new Error(`unresolved ${name} in ${expr}`);
    });
  }
  text = text.replace(/\bmax\(/g, "Math.max(").replace(/\bmin\(/g, "Math.min(").replace(/\bcalc\(/g, "(");
  text = text
    .replace(/(\d*\.?\d+)rem\b/g, (_, n: string) => `(${Number(n) * REM})`)
    .replace(/(\d*\.?\d+)em\b/g, (_, n: string) => `(${Number(n) * em})`)
    .replace(/(\d*\.?\d+)px\b/g, "$1");
  // eslint-disable-next-line no-new-func
  const value = Function(`"use strict"; return (${text});`)() as number;
  if (!Number.isFinite(value)) throw new Error(`${expr} came to ${value}`);
  return value;
}

/** Splits a function's argument list on its own commas, ignoring any inside a
 * nested call. */
function args(inner: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    if (inner[i] === "(") depth++;
    else if (inner[i] === ")") depth--;
    else if (inner[i] === "," && depth === 0) {
      out.push(inner.slice(start, i));
      start = i + 1;
    }
  }
  out.push(inner.slice(start));
  return out.map((a) => a.trim());
}

/** Rewrites the innermost `name(…)` call with `replace`, until there are none
 * left — innermost first, so an argument is plain arithmetic by the time its
 * own call is rewritten. */
function rewriteCalls(expr: string, name: string, replace: (parts: string[]) => string): string {
  for (;;) {
    const open = expr.lastIndexOf(`${name}(`);
    if (open < 0) return expr;
    let depth = 0;
    let close = -1;
    for (let i = open + name.length; i < expr.length; i++) {
      if (expr[i] === "(") depth++;
      else if (expr[i] === ")" && --depth === 0) {
        close = i;
        break;
      }
    }
    if (close < 0) throw new Error(`unterminated ${name}() in ${expr}`);
    expr = expr.slice(0, open) + replace(args(expr.slice(open + name.length + 1, close))) + expr.slice(close + 1);
  }
}

/** A shorthand's own figures, split on the spaces between them and not on the
 * spaces *inside* them — which `twoUp` below cannot do, its splitter being a
 * lookahead that any nested `calc(a + var(b))` defeats. Kept beside it rather
 * than folded into it: the callers that read a plain `1.2rem 1.9rem` are fine
 * as they are, and the one that reads the relation label's padding is not. */
function shorthandParts(value: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  const text = value.replace(/\s+/g, " ").trim();
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")") depth--;
    else if (text[i] === " " && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

/** The two figures of a `padding`/`margin` shorthand written as `a b`, in
 * pixels: block-axis-of-the-page first, inline second. Every rule this reads
 * writes exactly two, which is asserted rather than assumed. */
function twoUp(
  shorthand: string,
  opts?: { em?: number; vars?: Record<string, string> },
): { updown: number; leftright: number } {
  const parts = args(shorthand.replace(/\s+/g, " ").replace(/ (?![^(]*\))/g, ","));
  expect(parts.length, shorthand).toBe(2);
  return { updown: lengthOf(parts[0], opts), leftright: lengthOf(parts[1], opts) };
}

// ── The menu, as a table of cells ────────────────────────────────────────
//
// `sizeMenuSquarish` (tokenInspector.ts) wraps a menu into columns and the
// column count is what a figure's width turns on. Everything it needs is a
// whole number of cells, which is the single constraint the whole of
// kunten.css's menu section is written to — see `.token-context-menu`'s own
// note on the grid. So the model here is: how many cells long is each atom,
// how wide is a lane, and what does the wrap do with that.

const MENU = declarations(ruleBody(kunten, ".token-context-menu", "--menu-cell"));
/** The menu's own type size, which is the cell: `--menu-cell: 1em` declared on
 * this element and registered as a `<length>` so what inherits is the pixels. */
const MENU_EM = lengthOf(MENU.get("font-size")!, { em: REM });
const CELL = lengthOf(MENU.get("--menu-cell")!, { em: MENU_EM });
/** `--menu-cell` as the descendants see it: registered as a `<length>`, so it
 * is resolved on the element that declares it and what inherits is the pixels
 * rather than the `1em` (see the property's own note in kunten.css). Every
 * rule below that spells a figure as a fraction of the cell needs it. */
const MENU_VARS = { "--menu-cell": `${CELL}px` };
const menuLen = (expr: string, em = MENU_EM) => lengthOf(expr, { em, vars: MENU_VARS });
const menuTwoUp = (expr: string, em = MENU_EM) =>
  twoUp(expr, { em, vars: MENU_VARS });
/** The lane an entry stands in, across the run: `line-height × font-size` is
 * the line box's *across* size under vertical-rl, so 1.5 is 1.5 cells. */
const LANE = Number(MENU.get("line-height")) * MENU_EM;
/** The gutter between two columns of one category, and between two categories
 * — `row-gap` resolves along the block axis, which here is the horizontal one. */
const COLUMN_GAP = menuLen(args(MENU.get("gap")!.replace(/ (?![^(]*\))/g, ","))[0]);
const GROUP_GAP = menuLen(
  args(declarations(ruleBody(kunten, ".token-menu-group")).get("gap")!.replace(/ (?![^(]*\))/g, ","))[0],
);
/** What the menu's own box adds to the table it holds: `四分` of padding and a
 * 1px 匡郭 on each side across the run, and 0.425rem plus the same border
 * along it. `inlineBoxExtra` reads the second of these off the element. */
const MENU_EXTRA_ACROSS =
  2 * menuTwoUp(MENU.get("padding")!).leftright + 2 * lengthOf(MENU.get("border")!.split(" ")[0]);
const MENU_EXTRA_ALONG =
  2 * menuTwoUp(MENU.get("padding")!).updown + 2 * lengthOf(MENU.get("border")!.split(" ")[0]);

/** 二分 at each end of an entry, which is the figure the grid turns on: two
 * adjacent entries put half a cell each into the space between them, so the
 * last character of one stands exactly one cell from the first of the next. */
const ENTRY_PAD = menuTwoUp(declarations(ruleBody(kunten, ".token-menu-item")).get("padding")!).updown;

/** A whole entry — the part-of-speech menu's tags and the readings menu's
 * candidates — is `n` cells of characters and 二分 at each end. */
const entryExtent = (label: string) => [...label].length * CELL + 2 * ENTRY_PAD;

const HEADING = declarations(ruleBody(kunten, ".token-menu-heading"));
const HEADING_EM = lengthOf(HEADING.get("font-size")!, { em: MENU_EM });

/** A category heading is one line of smaller characters tracked out to a cell
 * each, in a cartouche one cell longer than the label — `(n + 1)` cells, which
 * is what `sizeMenuSquarish`'s own note records and what the pieces come to:
 * a `text-indent` of one tracking, `n` glyphs each followed by one, and then
 * the frame's margin and rule at both ends. Summed from the declarations
 * rather than taken as `(n + 1) · CELL`, so that a change to any one of them
 * shows up here as a heading of some other length rather than silently
 * agreeing with a formula. */
function headingExtent(label: string): number {
  const n = [...label].length;
  const tracking = menuLen(HEADING.get("letter-spacing")!, HEADING_EM);
  const indent = menuLen(HEADING.get("text-indent")!, HEADING_EM);
  const margin = menuTwoUp(HEADING.get("margin")!, HEADING_EM).updown;
  const rule = lengthOf(HEADING.get("border")!.split(" ")[0]);
  return indent + n * (HEADING_EM + tracking) + 2 * margin + 2 * rule;
}

const SEG_PAD = menuTwoUp(declarations(ruleBody(kunten, ".token-menu-seg", "padding: 0.5em")).get("padding")!).updown;
/** What a segment gives up at the end that abuts a 中黒 — 四分 where it would
 * otherwise carry 二分, the other 四分 coming from the segment on the far side,
 * so that the mark stands in a cell the two of them paid for between them. */
const SEG_PAD_AT_NAKAGURO = menuLen(
  declarations(ruleBody(kunten, ".token-menu-seg:has(+ .token-menu-punct:not(.subtype-bracket-open, .subtype-bracket-close))")).get(
    "padding-bottom",
  )!,
);

/** A relation row's extent, piece by piece.
 *
 * Every piece is a whole number of cells or costs the row nothing, which is
 * `.token-menu-seg`'s closing argument. A bracket is 二分 of ink (`vhal`) with
 * 二分 of aki written on it — before the 〖 and after the 〗 — so it is exactly
 * one cell; a 中黒 is 二分 of ink that its two neighbours make room for out of
 * their own padding, so it is half a cell and takes a 四分 off each of them.
 *
 * Checked against the one row the stylesheet writes down: 並列構成要素〖動詞
 * 連続・外来語〗 comes to 360 on the grid, which `.token-menu-seg`'s note
 * records and the block below asserts. */
function rowExtent(segments: readonly { kind: string; text: string }[]): number {
  const bracket = (s: { kind: string; text: string }) => s.kind === "punct" && (s.text === "〖" || s.text === "〗");
  const nakaguro = (s?: { kind: string; text: string }) => s !== undefined && s.kind === "punct" && !bracket(s);
  let total = 0;
  segments.forEach((seg, i) => {
    if (seg.kind === "punct") {
      total += bracket(seg) ? CELL : CELL / 2;
      return;
    }
    const before = nakaguro(segments[i - 1]) ? SEG_PAD_AT_NAKAGURO : SEG_PAD;
    const after = nakaguro(segments[i + 1]) ? SEG_PAD_AT_NAKAGURO : SEG_PAD;
    total += [...seg.text].length * CELL + before + after;
  });
  return total;
}

/** **How wide a menu comes out**, by running `sizeMenuSquarish`'s own
 * arithmetic over the atoms it would be handed.
 *
 * `groups` is one array of atom extents per category, in menu order; an atom
 * is a whole entry, a relation row, or the `.token-menu-group-lead` that binds
 * a heading to its own first entry. The wrap is greedy along the inline axis
 * at whatever cap the squaring settles on, and the column count is what the
 * width is made of: `C` lanes, `C − 1` gutters, and the menu's own box.
 *
 * **The two later passes cannot move the count**, which is why they are not
 * modelled. `shrinkMenuToContent` and `avoidWidowColumns` only ever *lower* a
 * cap, and a lower cap can only add columns — both of them measure the count
 * afterwards and roll the change back if it grew. So the count is what the
 * squaring loop leaves, and what they take off is height. */
function menuGeometry(groups: number[][]): { columns: number; width: number; along: number; cap: number } {
  const atoms = groups.flat();
  const totalInline = atoms.reduce((a, b) => a + b, 0);
  const columnWidth = LANE + COLUMN_GAP;
  const tallestAtom = Math.max(...atoms);
  // The viewport ceiling is dropped — see the header of this file.
  const clamp = (h: number) => Math.max(tallestAtom, h);
  const bias =
    (groups.length / 2) * columnWidth + (groups.length - 1) * Math.max(0, GROUP_GAP - COLUMN_GAP);

  const wrap = (cap: number) =>
    groups.reduce((columns, group) => {
      let used = Infinity;
      for (const atom of group) {
        if (used + atom > cap) {
          columns++;
          used = atom;
        } else used += atom;
      }
      return columns;
    }, 0);

  let height = clamp((bias + Math.sqrt(bias * bias + 4 * totalInline * columnWidth)) / 2);
  let columns = wrap(Math.ceil(height));
  for (let i = 0; i < 3; i++) {
    const width = columns * LANE + (columns - 1) * COLUMN_GAP + MENU_EXTRA_ACROSS;
    const box = Math.ceil(height) + MENU_EXTRA_ALONG;
    if (Math.abs(width - box) / Math.max(width, box) < 0.05) break;
    const next = clamp((box - MENU_EXTRA_ALONG) * Math.sqrt(width / box));
    if (Math.abs(next - height) < 1) break;
    height = next;
    columns = wrap(Math.ceil(height));
  }
  return {
    columns,
    width: columns * LANE + (columns - 1) * COLUMN_GAP + MENU_EXTRA_ACROSS,
    along: Math.ceil(height) + MENU_EXTRA_ALONG,
    /** The cap the loop settled at, which is what the greedy wrap above packs
     * each column to — and so what decides where in the run an entry stands.
     * The clamp's arithmetic needs that and not merely the table's extent. */
    cap: Math.ceil(height),
  };
}

/** The columns the wrap above leaves, as the atoms that stand in them and
 * where in the run each one begins.
 *
 * The same greedy pass, kept beside it rather than folded into it because what
 * it answers is a different question: `menuGeometry` says how big the table
 * comes out, and this says what is *where* in it — which is what the clamp cuts
 * across. Every column begins at the top of the run, so one cut depth applies
 * to all of them at once. */
function packColumns(atoms: { label: string; extent: number }[], cap: number): { label: string; extent: number; start: number }[][] {
  const columns: { label: string; extent: number; start: number }[][] = [];
  let used = Infinity;
  for (const atom of atoms) {
    if (used + atom.extent > cap) {
      columns.push([{ ...atom, start: 0 }]);
      used = atom.extent;
    } else {
      const column = columns[columns.length - 1];
      column.push({ ...atom, start: used });
      used += atom.extent;
    }
  }
  return columns;
}

/** One category, as `sizeMenuSquarish` sees it: the heading bound to its own
 * first entry as a single atom, then the rest one atom apiece. */
const group = (heading: string, entries: number[]) => [headingExtent(heading) + entries[0], ...entries.slice(1)];

// ── The figures ──────────────────────────────────────────────────────────

const STEPS = declarations(ruleBody(app, ".help-steps"));
/** The grid column, which is the figure's border box: the dialog is sized from
 * these rather than the other way about (`.help-modal`). */
const COLUMN = lengthOf(/repeat\(\s*\d+\s*,\s*([^)]+)\)/.exec(STEPS.get("grid-template-columns")!)![1]);

const FIGURE = declarations(ruleBody(app, ".help-figure"));
const FIGURE_BORDER = lengthOf(FIGURE.get("border")!.split(" ")[0]);
const FIGURE_PAD = twoUp(FIGURE.get("padding")!).leftright;
/** Down the page rather than across it: the other figure of the same
 * shorthand, which with the border is what a figure adds to its contents'
 * height. */
const FIGURE_PAD_BLOCK = twoUp(FIGURE.get("padding")!).updown;
const FIGURE_CHROME = 2 * (FIGURE_PAD_BLOCK + FIGURE_BORDER);
/** **The clamp**: the one height every figure is declared at, and the whole of
 * what this file's height half is now about. Read off `.help-figure` rather
 * than written down, so that moving it is what makes the assertions below
 * fail. */
const CLAMP = lengthOf(FIGURE.get("height")!);
/** The tight gap a figure uses when nothing is standing in it — the menu
 * belongs right beside the character it was opened from. */
const TIGHT_GAP = lengthOf(FIGURE.get("gap")!);
const GUTTER = lengthOf(declarations(ruleBody(app, ".help-figure-menu-gutter")).get("gap")!);
const PAIR_GAP = lengthOf(declarations(ruleBody(app, ".help-figure-pair")).get("gap")!);
const UNDO = declarations(ruleBody(app, ".help-figure-undo"));
const UNDO_GAP = lengthOf(UNDO.get("gap")!);
const UNDO_MARGIN = lengthOf(
  declarations(ruleBody(app, ".help-figure-undo > .help-sample:last-child")).get("margin-left")!,
);

/** One kanbun column across the page, and one of the kakikudashi panel's, which
 * is half of it — the samples are the panel's own cells at the panel's own
 * size (`.help-sample`), so a sample is exactly one pitch wide. */
const PITCH = lengthOf(TYPE.get("--column-pitch")!, { em: REM });
const PROSE_PITCH = lengthOf(TYPE.get("--column-pitch-kakikudashi")!, { em: REM });
/** The kakikudashi panel's own type, which is half its pitch — so that column,
 * like a kanbun one, is wider than the text set in it. */
const PROSE_SIZE = lengthOf(TYPE.get("--size-kakikudashi")!, { em: REM });
const FURIGANA = lengthOf(TYPE.get("--size-furigana")!, { em: REM });

/** One character *along* its column — itself and the gap that follows it — and
 * so the sample's height, four of them, the trailing gap included.
 *
 * The gap comes off again on a figure with nothing standing in it, which is
 * five of the eight (`.help-sample`, app.css). Which five is decided from the
 * laid-out figure by `keepFootGap`, so this file takes the taller of the two
 * for every figure and asserts a ceiling against it — see the note at the head
 * of this file on the two slacknesses in the height model. */
const KANJI_ADVANCE = lengthOf(TYPE.get("--kanji-advance")!, { em: REM });
const SAMPLE_HEIGHT = SAMPLE.length * KANJI_ADVANCE;
/** What the seven unstacked figures come to on their own: a sample and the
 * figure's own padding and border. The five without a chip at the foot are one
 * gap shorter. No figure stands at this any more — the clamp is 15.7 under it —
 * so what it is here for is the arithmetic below, which takes the *ink* out of
 * it rather than the box. */
const PLAIN_FIGURE_HEIGHT = SAMPLE_HEIGHT + FIGURE_CHROME;

/** One character across the page, which is also one down it: the glyph itself,
 * where `--kanji-advance` is the glyph and the gap that follows it. */
const GLYPH = lengthOf(TYPE.get("--size-main")!, { em: REM });
/** **How deep a sample's own characters run** — three advances and a glyph,
 * the trailing gap left out, because the gap is not ink. */
const GLYPHS_DEPTH = (SAMPLE.length - 1) * KANJI_ADVANCE + GLYPH;
/** How far a part-of-speech chip reaches below the foot of the character it
 * hangs under.
 *
 * The one recalled measurement left in this file, recorded at
 * `.help-figure-menu-below` (app.css) from a round that had a browser, and the
 * number the clamp is set from. It is the chip's box, so it is the chip's ink:
 * a pill paints its own background. */
const CHIP_FOOT_REACH = 28.3;
/** **The lowest ink in the dialog that is not a menu**, measured from the first
 * character's top edge: the characters themselves, and then the chip hanging
 * under the last of them on the three figures whose arrow runs down the column.
 * This is what sets the clamp. */
const PLAIN_INK_DEPTH = GLYPHS_DEPTH + CHIP_FOOT_REACH;
/** The gap a stacked figure leaves between its sample and the menu subjoined
 * to it, which is 0 — the menu's top edge is against the pill's bottom edge on
 * screen (`.help-figure-menu-below`). Read rather than dropped, because it is a
 * term of the one height in this file that is a sum. */
const MENU_BELOW_GAP = lengthOf(declarations(ruleBody(app, ".help-figure-menu-below")).get("gap")!);

const KEYS_STACKED = lengthOf(declarations(ruleBody(app, ".help-keys-stacked kbd")).get("width")!);
const ARROWS = declarations(ruleBody(app, ".help-keys-arrows"));
const ARROW_KEYS = (() => {
  const [, count, size] = /repeat\(\s*(\d+)\s*,\s*([^)]+)\)/.exec(ARROWS.get("grid-template-columns")!)!;
  return Number(count) * lengthOf(size) + (Number(count) - 1) * lengthOf(ARROWS.get("gap")!);
})();

// ── The pointer ──────────────────────────────────────────────────────────
//
// 41.6px of arrow and mouse, anchored 72% of the way into whatever it points
// at and hanging down and to the right of there (`pointer`, HelpModal.ts). It
// is a `position: absolute` child of the figure, so it takes no part in the
// flex layout and every pixel of it past its target is ink outside the boxes —
// which is exactly what the arithmetic in app.css used to leave out.
const help = readFileSync(join(ROOT, "src", "render", "HelpModal.ts"), "utf-8");
const svgWidth = (cls: string) => Number(new RegExp(`class="${cls}[^"]*"[^>]*width="(\\d+)"`).exec(help)![1]);
const svgHeight = (cls: string) => Number(new RegExp(`class="${cls}[^"]*"[^>]*height="(\\d+)"`).exec(help)![1]);
const POINTER = declarations(ruleBody(app, ".help-pointer"));
const POINTER_WIDTH =
  svgWidth("help-pointer-arrow") +
  lengthOf(POINTER.get("gap")!) +
  twoUp(
    declarations(ruleBody(app, ".help-pointer-mouse")).get("margin")!.split(" ").filter((_, i) => i === 0 || i === 3).join(" "),
  ).leftright +
  svgWidth("help-pointer-mouse");
/** Where in its target the pointer's tip is put — the target's lower right
 * rather than its dead centre, so the arrow sits mostly clear of the thing it
 * indicates. Read off the source, since it is the whole of what decides how
 * far past a target a pointer reaches — and, since the readings menu is dropped
 * at that same point, where that menu's top right corner lands as well. */
const POINTER_ANCHOR = Number(/POINTER_TIP = ([\d.]+);/.exec(help)![1]);

/** How far a pointer reaches past the right edge of the box it is aimed at,
 * for a target of this width sitting `inset` from that edge. */
const pointerOverhang = (target: number, inset = 0) =>
  Math.max(0, POINTER_ANCHOR * target + POINTER_WIDTH - target - inset);

/** The chips' and the label's own type size: a fifth of the cell, set inline
 * by `showInspector` off `CHIP_SIZE_OF_CELL` (tokenInspector.ts). Read from
 * there rather than written down, since every mark the analysis draws is
 * measured in it. */
const CHIP_SIZE_OF_CELL = (() => {
  const expr = /CHIP_SIZE_OF_CELL = ([^;]+);/.exec(
    readFileSync(join(ROOT, "src", "render", "tokenInspector.ts"), "utf-8"),
  )![1];
  const [num, denominator] = expr.replace(/\s/g, "").split("/");
  return denominator === undefined ? Number(num) : Number(num) / Number(denominator);
})();
const CHIP_EM = PITCH * CHIP_SIZE_OF_CELL;
/** The hairline every mark of the analysis is ringed with, declared on the
 * overlay that carries them all (`.token-inspector-overlay`, kunten.css). */
const MARK_EDGE = lengthOf(
  declarations(ruleBody(kunten, ".token-inspector-overlay", "--mark-edge")).get("--mark-edge")!,
);

/** **How far a relation label reaches past the left edge of the sample it is
 * drawn on**, which is half its own box.
 *
 * `showInspector` hangs the label on the gutter beside the column — `labelX =
 * midX - cell/2`, the column's own left edge — and `.token-arrow-label` is
 * `transform: translate(-50%, -50%)`, so exactly half of it is outside the
 * sample. The box is one line of vertical text: `line-height` of the chip em
 * across the run, and `0.15rem + --mark-edge` of padding at each end.
 *
 * **This was 31**, carried in this file and in app.css as a measurement from a
 * round that had a browser, and it is 14.46. Nothing about the label has
 * changed; the number was simply wrong, and two rounds of figures were laid out
 * around 16.5px of label that is not there — a 2rem gutter for it in the
 * relation step, which is what took that figure two pixels past its column, and
 * a claim in this file that the undo step had 21.3px of clear at each border
 * when the boxes said 29.6. It is derived here for that reason.
 *
 * The label does not move afterwards: it steps sideways only for the
 * *inspected token's own* ruby (`INSPECTED_READINGS`), which in this panel
 * stands in the lane on the other side of the glyph, so the dodge that could
 * carry it further into the gutter never fires here. The block at the foot of
 * this file argues that, since it is the thing a reader would suspect first. */
const LABEL_BOX = (() => {
  const label = declarations(ruleBody(kunten, ".token-arrow-label", "writing-mode"));
  // Across the run: one line box of the chip's own em. The padding is the
  // second figure of the shorthand — the physical left and right — since the
  // label is set vertically and the run is the horizontal axis.
  const across = Number(label.get("line-height")) * CHIP_EM;
  const [, inline] = shorthandParts(label.get("padding")!);
  const pad = lengthOf(inline, { em: CHIP_EM, vars: { "--mark-edge": `${MARK_EDGE}px` } });
  return across + 2 * pad;
})();
const LABEL_OVERHANG = LABEL_BOX / 2;

/** The three menus, wrapped as `sizeMenuSquarish` would wrap them, off the
 * entry lists the figures are actually built from — all three of them whole,
 * which is what the reader asked for and what the abbreviation that stood here
 * for a round took away. */
function menus() {
  const pos = menuGeometry([group("品詞", posMenuWords(SAMPLE[3].token).map(entryExtent))]);
  const relation = (() => {
    const { heading, rows } = deprelRowsShown();
    return menuGeometry([group(heading, rows.map((row) => rowExtent(row.segments)))]);
  })();
  const reading = menuGeometry(
    READING_MENU_GROUPS.map(({ heading, items }) => group(heading, items.map(entryExtent))),
  );
  return { pos, relation, reading };
}

/** The part-of-speech menu as atoms with their labels kept, which is what the
 * clamp has to be asked about: `menuGeometry` counts extents, and what is cut
 * is words. The heading and the entry `appendMenuGroup` binds it to are one
 * atom, exactly as they are in the wrap. */
function posAtoms(): { label: string; extent: number }[] {
  const [first, ...rest] = posMenuWords(SAMPLE[3].token);
  return [
    { label: `品詞+${first}`, extent: headingExtent("品詞") + entryExtent(first) },
    ...rest.map((label) => ({ label, extent: entryExtent(label) })),
  ];
}

/** **The entry the part-of-speech figure marks**, as it stands in the packing:
 * which column it is in, where in the run it begins, and where it ends.
 *
 * The figure marks the token's own 品詞 — `posMenu` passes `syntacticPrefix` of
 * the xpos as the menu's `current`, exactly as `openRetagMenu` does — and the
 * step's prose says so in both languages. Half of what the clamp has to do is
 * keep that entry on the page, so this is the thing the clamp's second term is
 * computed from rather than a number written down beside it: an inventory that
 * reordered itself would move this, and the clamp would have to follow.
 *
 * The atom's *end* and not its last glyph: the mark is a box drawn on the entry
 * (`data-current`), so what has to be whole is the entry's own extent. That is
 * also the cut that falls between two entries in that column rather than inside
 * one. */
interface MenuItem {
  label: string;
  column: number;
  start: number;
  extent: number;
}

/** The part-of-speech menu as the reader meets it: every heading and every
 * entry, with the column it stands in and where in that column's run it begins.
 *
 * The heading is split back out of the atom `appendMenuGroup` binds it to,
 * because the wrap and the reader see different things there — the wrap sees
 * one item that may not be broken across columns, and the reader sees a
 * cartouche with an entry under it, either of which the clamp can cut. */
function menuItems(): MenuItem[] {
  const heading = headingExtent("品詞");
  return packColumns(posAtoms(), menus().pos.cap).flatMap((atoms, column) =>
    atoms.flatMap((atom) =>
      atom.label.startsWith("品詞+")
        ? [
            { label: "品詞", column, start: atom.start, extent: heading },
            {
              label: atom.label.slice("品詞+".length),
              column,
              start: atom.start + heading,
              extent: atom.extent - heading,
            },
          ]
        : [{ label: atom.label, column, start: atom.start, extent: atom.extent }],
    ),
  );
}

/** **The entry the part-of-speech figure marks**, where it stands in that.
 *
 * The figure marks the token's own 品詞 — `posMenu` passes `syntacticPrefix` of
 * the xpos as the menu's `current`, exactly as `openRetagMenu` does — and the
 * step's prose says so in both languages. Half of what the clamp has to do is
 * keep that entry on the page, so this is what the clamp's second term is
 * computed from rather than a number written down beside it: an inventory that
 * reordered itself would move this, and the clamp would have to follow.
 *
 * The entry's *extent* and not its last glyph: the mark is drawn on the entry
 * itself (`data-current`), so what has to be whole is its own box. That is also
 * the cut that falls between two entries in that column rather than inside one. */
function markedAtom(): MenuItem {
  const own = syntacticPrefix(SAMPLE[3].token.xpos)!;
  const word = own.split(",")[1];
  const marked = menuItems().find((item) => item.label === word);
  if (!marked) throw new Error(`the figure marks ${word}, which is not in its own menu`);
  return marked;
}

/** What a cut at `run` leaves of each of them: an item whose box ends above the
 * cut is whole, one whose glyphs straddle it is shown in part, and one that has
 * not begun is absent. A glyph begins 二分 into an entry and the run of them
 * ends a 二分 before it does, which is the same grid the whole menu is set on. */
function atCut(run: number): { whole: string[]; part: string[]; absent: string[] } {
  const whole: string[] = [];
  const part: string[] = [];
  const absent: string[] = [];
  for (const item of menuItems()) {
    if (item.start + item.extent <= run) whole.push(item.label);
    else if (item.start + ENTRY_PAD < run) part.push(item.label);
    else absent.push(item.label);
  }
  return { whole, part, absent };
}

/** What a menu's own box spends before its first row — 0.425rem of padding and
 * a 1px 匡郭 along the run. Half of `MENU_EXTRA_ALONG`, and it is the leading
 * half that the clamp's arithmetic needs: the trailing half is below the cut. */
const MENU_BOX_LEAD = menuTwoUp(MENU.get("padding")!).updown + lengthOf(MENU.get("border")!.split(" ")[0]);

/** **How much of the stacked figure's menu the clamp leaves showing.**
 *
 * `overflow: hidden` clips at the *padding* box, so the figure's own bottom
 * padding is room its contents may be painted into: what is visible below the
 * top border is `height − border − padding` of content, less the closing
 * border. Take off the ink above the menu — the characters and the chip under
 * the last of them, which is where `joinMenuToPill` now hangs the table from —
 * and the menu's own leading box, and what is left is the run the reader sees.
 *
 * `MENU_TOP` is that sum — everything between the figure's top border and the
 * first row of the table, plus the closing border the clip sits on — so the
 * clamp and the run the figure shows are one addition apart in either
 * direction, which is what lets the clamp be *derived* from the run it has to
 * reach rather than checked against it.
 *
 * Computed from the declarations rather than written down, so that moving the
 * clamp, the padding, the advance or the menu's own box moves this with it —
 * and the assertions below are about where this lands among the entries. */
const MENU_TOP =
  2 * FIGURE_BORDER + FIGURE_PAD_BLOCK + PLAIN_INK_DEPTH + MENU_BELOW_GAP + MENU_BOX_LEAD;
const POS_MENU_RUN_SHOWN = CLAMP - MENU_TOP;

/** The slack inside a sample's own box: a reading lane is a 四分 of the pitch
 * and the kana standing in it are `--size-furigana`, so a sample's painted ink
 * stops this far inside its right-hand edge. `centreFigureContents` measures
 * ink, so this comes off wherever a sample is a figure's rightmost thing. */
const RUBY_SLACK = PITCH / 4 - FURIGANA;
const SAMPLE_INK_RIGHT = PITCH - RUBY_SLACK;

// ── The category chips ───────────────────────────────────────────────────
//
// One figure draws the row unfolded (`.help-figure-unfolded`, app.css) and is
// the widest in the dialog for it, so the three pills have to be measured
// rather than waved at. Every piece is a declaration: the em is a fifth of the
// cell, the padding is `--chip-pad-inline`, the notch each pill cuts out of its
// predecessor is `--chip-chevron`, and the seam it leaves is
// `--chip-chevron-gap`.
const CHIP = declarations(ruleBody(kunten, ".token-subtitle", "--chip-pad-inline"));
const CHIP_PAD = lengthOf(CHIP.get("--chip-pad-inline")!, { em: CHIP_EM });
/** The notch each pill cuts out of its predecessor's trailing edge. Declared
 * on the overlay rather than on the pill — the row uses it too, and a custom
 * property does not inherit upward — and written in `em`, which resolves
 * against whichever element spends it; all four carry the chip's size inline
 * (`.token-inspector-overlay` in kunten.css says so). */
const CHIP_CHEVRON = lengthOf(
  declarations(ruleBody(kunten, ".token-inspector-overlay", "--chip-chevron")).get("--chip-chevron")!,
  { em: CHIP_EM },
);
const CHIP_CHEVRON_GAP = lengthOf(
  declarations(ruleBody(kunten, ":root", "--head-box-halo")).get("--head-box-halo")!,
);
/** The padding on the end of a pill that has a neighbour: the plain padding and
 * half a chevron, which is what `.token-subtitle:not(:last-child)` (the
 * trailing end) and `.token-subtitle-semantics > .token-subtitle` (the leading
 * one) both declare. */
const CHIP_PAD_AT_NOTCH = CHIP_PAD + CHIP_CHEVRON / 2;
/** A pill's own box, given the characters in it and whether each end abuts a
 * neighbour. */
const chipWidth = (label: string, leads: boolean, trails: boolean) =>
  [...label].length * CHIP_EM + (leads ? CHIP_PAD_AT_NOTCH : CHIP_PAD) + (trails ? CHIP_PAD_AT_NOTCH : CHIP_PAD);
/** **How far the unfolded foldout reaches past the 品詞 pill's trailing edge.**
 * The wrapper is `left: 100%` of the row — the pill's own border box — so this
 * is the run's whole width: two pills, each pulled back over its predecessor's
 * point by the chevron less the seam. 信's tag is `v,動詞,行為,態度`, so the two
 * are 行為 and 態度. */
const SEMANTICS_RUN =
  chipWidth("行為", true, true) +
  chipWidth("態度", true, false) +
  2 * (-CHIP_CHEVRON + CHIP_CHEVRON_GAP);

/** **The stagger**: how far below the column that begins a figure the thing
 * beside it sits.
 *
 * One is at `align-self: flex-start` and the other is centred — the figure's
 * own `align-items: center`, or the aside's `justify-content: center` — so the
 * offset is half of what the figure holds less what is beside it. It is not a
 * declared number and moves with the box; what is asserted about it is that it
 * exists on every figure that holds two columns.
 *
 * `SAMPLE_HEIGHT` is the box of a sample whose trailing gap houses a chip,
 * which is the taller of the two a figure can have and so the smaller offset —
 * the safe direction for a ceiling, as everywhere else in this file. */
const CONTENT_HEIGHT = CLAMP - 2 * (FIGURE_BORDER + FIGURE_PAD_BLOCK);
const STAGGER = (CONTENT_HEIGHT - SAMPLE_HEIGHT) / 2;

/** How far down a figure a pointer reaches past the top of what it points at:
 * it is anchored `POINTER_ANCHOR` into the target and hangs below that. The
 * mouse is the lower of its two parts — 24px of SVG under a 0.85rem top margin
 * against 28px of arrow — which is the kind of thing a table of widths misses
 * and a clamp does not. */
const POINTER_DEPTH = Math.max(
  svgHeight("help-pointer-arrow"),
  twoUp(
    declarations(ruleBody(app, ".help-pointer-mouse")).get("margin")!.split(" ").filter((_, i) => i === 0 || i === 3).join(" "),
  ).updown + svgHeight("help-pointer-mouse"),
);

/** What one figure paints: the leftmost ink to the rightmost across the page,
 * and the topmost to the lowest down it, in pixels. */
interface Figure {
  key: string;
  ink: number;
  why: string;
  /** How tall the painted ink is — *not* how far down the figure it reaches.
   * The two were the same thing while every sample hung from the top of its
   * box; `centreFigureInk` now places each figure's ink in the middle of its
   * own, so what the clamp has to clear is a height. */
  inkHeight: number;
  whyTall: string;
}

function figures(): Figure[] {
  const { pos, relation, reading } = menus();

  // **Down the page there are three shapes.** A figure holding one column is
  // as tall as that column's ink; one holding two is that plus the stagger
  // between them; and the stacked one is a column and a table, one below the
  // other, which is the only ink in the dialog taller than its box.
  //
  // Which ink a column has is decided by where its arrow ran: an analysis on
  // the *last* character hangs its chip below the column and adds the chip's
  // reach, and one anywhere else keeps the chip inside the run of characters.
  // Every figure below is given the taller of the two — the file's standing
  // slackness, and in the safe direction for a ceiling.
  const oneColumn = { inkHeight: PLAIN_INK_DEPTH, whyTall: "the characters, and the chip under the last of them" };
  const twoColumns = {
    inkHeight: PLAIN_INK_DEPTH + STAGGER,
    whyTall: "the two columns, staggered",
  };

  return [
    {
      key: "select",
      // Two samples, and the right-hand one carries the analysis — its label
      // hangs into the 2rem between them, and its pointer past its own right
      // edge. The left-hand sample's pointer falls in the same gap.
      ink: PITCH + PAIR_GAP + PITCH + pointerOverhang(PITCH / 2, PITCH / 4),
      why: "sample + 2rem + sample, plus the right-hand pointer",
      ...twoColumns,
    },
    {
      key: "highlight",
      // The kakikudashi column beside it is half a pitch of box holding
      // `--size-kakikudashi` of text, so its own lane slack comes off too.
      ink: PITCH + TIGHT_GAP + PROSE_PITCH - (PROSE_PITCH - PROSE_SIZE) / 2,
      why: "sample + tight gap + one kakikudashi column",
      // Two columns, but the second is a short one centred against the first
      // and nowhere near its ends, so the kanbun column alone decides this.
      ...oneColumn,
    },
    {
      key: "navigate",
      ink: PITCH + TIGHT_GAP + ARROW_KEYS,
      why: "sample + tight gap + the inverted T",
      ...oneColumn,
    },
    {
      key: "pos",
      // **The widest thing in this figure is no longer the sample.** A category
      // menu is subjoined to its pill, so the table hangs 202 to the left of
      // the pill's trailing edge — and the unfolded foldout runs 96.2 to the
      // right of that same edge. The two are measured from one point, so the
      // figure's ink is their sum and the sample (88, and inside both) does not
      // enter into it.
      ink: pos.width + SEMANTICS_RUN,
      why: "the menu hung from the pill's trailing edge, and the foldout run the other way",
      // And the one ink in the dialog that is a sum down the page: the column,
      // and then the table `joinMenuToPill` drops onto the chip's foot. It is
      // what the clamp cuts, and what `centreFigureInk` hangs from the top
      // rather than centring.
      inkHeight: PLAIN_INK_DEPTH + pos.along,
      whyTall: "the column, and the table under the chip at its foot",
    },
    {
      key: "relation",
      // The label hangs into the 1.5rem gutter and the pointer that rests on it
      // points back across the sample, so neither is outside the boxes. The
      // menu is: five rows of 基本成分 wrap into five columns (ROOT's own row
      // left the group when it was promoted to its own singleton category;
      // see `deprelRowsShown`).
      ink: relation.width + GUTTER + SAMPLE_INK_RIGHT,
      why: "menu + 1.5rem gutter + sample",
      // One column and a menu beside it, and the menu is shorter than the
      // column (asserted below).
      ...oneColumn,
    },
    {
      key: "reading",
      // **The menu is dropped at the pointer**, not set beside the text: its
      // top right corner lands on the same point the pointer's tip does
      // (`dropMenuAtPointer`), so it reaches its own width to the left of that
      // point while the pointer reaches its own width to the right. The sample
      // is inside both, and the figure's ink is the two of them end to end.
      ink: reading.width + POINTER_WIDTH,
      why: "the menu leftward from the pointer's tip, and the pointer rightward from it",
      // No arrow on this one, so no chip — but the ceiling above is what every
      // other figure is given, and the same one is safe here.
      ...oneColumn,
    },
    {
      key: "head",
      // Both samples carry an analysis here, so the *left* one's label hangs
      // out past the figure's own contents rather than into a gap.
      ink: LABEL_OVERHANG + PITCH + PAIR_GAP + SAMPLE_INK_RIGHT,
      why: "a label's overhang + sample + 2rem + sample",
      ...twoColumns,
    },
    {
      key: "undo",
      // State, keystroke, state, with the gaps paid for asymmetrically — the
      // tight one on the left, where nothing stands, and 2rem on the right,
      // which is what the right-hand sample's own label hangs into.
      ink: LABEL_OVERHANG + PITCH + UNDO_GAP + KEYS_STACKED + UNDO_GAP + UNDO_MARGIN + SAMPLE_INK_RIGHT,
      why: "a label's overhang + sample + caps + sample",
      // Staggered like the other two-column figures, which it was not until the
      // rule that hangs a column from the top was scoped to the *first* one:
      // this is the figure that appends its three parts to itself directly, so
      // both its samples used to take it.
      ...twoColumns,
    },
  ];
}

describe("the menu geometry the figures are built on", () => {
  it("is the 20px grid kunten.css says it is", () => {
    expect(CELL).toBe(20);
    expect(LANE).toBe(1.5 * CELL);
    expect(COLUMN_GAP).toBe(CELL / 2);
    // A category boundary is an ordinary column boundary: the two gutters are
    // both 二分, which is what takes `Δ` out of the quadratic.
    expect(GROUP_GAP).toBe(COLUMN_GAP);
    expect(MENU_EXTRA_ACROSS).toBe(2 * (CELL / 4) + 2);
  });

  it("makes every atom a whole number of cells", () => {
    for (const label of ["名詞", "代名詞", "けい", "うやまフ"]) {
      expect(entryExtent(label) % CELL, label).toBe(0);
      expect(entryExtent(label)).toBe(([...label].length + 1) * CELL);
    }
    for (const label of ["品詞", "基本成分", "音読み"]) {
      expect(headingExtent(label), label).toBe(([...label].length + 1) * CELL);
    }
  });

  it("measures a bracketed row the length kunten.css records", () => {
    // The one row the stylesheet writes down — `.token-menu-seg`'s note has it
    // at 360 on the grid, against 349.2 with the old 0.35rem padding. It is
    // also the tallest atom in the whole relation menu, and so the floor under
    // every cap `sizeMenuSquarish` writes.
    const row = [
      { kind: "relation", text: "並列構成要素" },
      { kind: "punct", text: "〖" },
      { kind: "relation", text: "動詞連続" },
      { kind: "punct", text: "・" },
      { kind: "relation", text: "外来語" },
      { kind: "punct", text: "〗" },
    ];
    expect(rowExtent(row)).toBe(360);
    // And the row the tutorial's own figure shows, which is whichever of the
    // shown category's rows carries a subtype (`deprelRowsShown`). It was
    // 斜格補語〖場所〗 at 200 while `comp:obl` was filed with the arguments; the
    // re-filing under 『体系漢文』's 成分 moved that relation to the modifiers,
    // where the handbook puts its 補語, so the subtyped row the figure now
    // reaches for is 補語〖形式〗 — two characters shorter on each side of the
    // bracket, and **160**. The figure's own wrap follows it below.
  });

  it("wraps the part-of-speech menu into five columns of 202px", () => {
    // **The figure shows all eleven entries.** This is the number that has
    // moved three times. Four columns at the old 30.1px lane and 5.6px gutter
    // came to 163.2; the 20px grid took the whole menu to five columns and 202,
    // which is what put the figure past its border and made this file; a round
    // of abbreviation cut it to three entries and a 三点リーダー, three columns
    // and 122; and the reader has since asked for the menus whole and the
    // figures clamped instead. So it is five columns and 202 again, and the
    // 226.6 of table under a 352 sample is what the clamp in `.help-figure` is
    // set against.
    const all = posMenuWords(SAMPLE[3].token);
    expect(all.length).toBe(11);
    // In the menu's own order, which is the order the clip then cuts across:
    // 動詞 is 信's own 品詞 in the treebank's parse and is what this figure
    // marks, and where it falls among the eleven is what decides whether the
    // reader can see the mark at all. The clamp's own block below asserts that.
    expect(all.slice(0, 3)).toEqual(["名詞", "代名詞", "動詞"]);

    const menu = menuGeometry([group("品詞", all.map(entryExtent))]);
    expect(menu.columns).toBe(5);
    expect(menu.width).toBe(202);
    expect(menu.along).toBeCloseTo(226.6, 6);
    // 226.6 and not the 207.6 `.help-figure-menu-below` used to record. That
    // number was a cap of 192 read off the squaring's *first* guess; the
    // squaring then iterates, and over five columns of 202 it settles at 211.
    // Which is the whole argument for this file in one line: the stylesheet's
    // figure was arrived at by hand, and nothing made it run the loop.
    expect(menu.cap).toBe(211);
  });

  it("wraps the relation menu into five columns as well, and the readings into three", () => {
    // **Five rows of 基本成分**, which is the whole category `deprelRowsShown`
    // draws now that ROOT has left it for a singleton category of its own
    // (`deprelMenuGroups()[0]`, unreached here because it has nothing to set
    // a subtype beside — see that function's own doc). The cap is floored at
    // the tallest atom and there are still two of 160 — the heading bound to
    // 主語 (100 + 60) and 補語〖形式〗 (60 + 20 + 60 + 20), neither of them
    // ROOT's own row — so the squaring settles at 177 this time rather than
    // 180, three short of what 目的語 (80) and 述語補語 (100) together would
    // need to share a column the way 文の主辞 and 目的語 used to: every row
    // now stands alone in its own column. Five atoms, five columns regardless
    // — the width formula only ever counts columns — so it is unchanged: `5·30
    // + 4·10 + 12 = 202`.
    const { heading, rows } = deprelRowsShown();
    expect(heading).toBe("基本成分");
    expect(rows.map((row) => row.segments.map((seg) => seg.text).join(""))).toEqual([
      "主語",
      "目的語",
      "述語補語",
      "助動詞補語",
      "補語〖形式〗",
    ]);

    const relation = menuGeometry([group(heading, rows.map((row) => rowExtent(row.segments)))]);
    expect(relation.columns).toBe(5);
    expect(relation.width).toBe(202);
    // And it stands *beside* a sample rather than under one, so those five
    // columns are what makes this the widest figure in the dialog. At the 2rem
    // gutter it used to keep — for a label recorded as 31px wide and actually
    // 14.46 — the boxes came to 322 against a 320px column; at 1.5rem they are
    // 314, and the ink 306.7.
    expect(relation.width + GUTTER + PITCH).toBe(314);

    // The readings menu is three columns and always was — two categories, three
    // candidates, nothing that wraps differently whole than it did cut.
    const reading = menuGeometry(
      READING_MENU_GROUPS.map(({ heading: h, items }) => group(h, items.map(entryExtent))),
    );
    expect(reading.columns).toBe(3);
    expect(reading.width).toBe(122);
  });
});

describe("each figure inside its own box", () => {
  it("draws eight of them", () => {
    // The count is the dialog's own rule — one figure per step — and a step
    // added without a line here would otherwise be a step this file does not
    // check.
    expect(figures()).toHaveLength(8);
  });

  it("is 320px wide, which is where the clip falls", () => {
    expect(COLUMN).toBe(320);
    expect(COLUMN - 2 * FIGURE_PAD - 2 * FIGURE_BORDER).toBeCloseTo(257.2, 6);
  });

  /** The box the clip is taken at: the border box less its borders. `overflow:
   * hidden` on `.help-figure` cuts there, and `centreFigureContents` centres
   * against the same box, so this — not the border box, and not the content box
   * — is the line a figure's ink has to stay inside. */
  const CLIP_BOX = COLUMN - 2 * FIGURE_BORDER;

  for (const figure of figures()) {
    it(`keeps the ${figure.key} step's ink inside the box the clip is taken at`, () => {
      // Ink, and the padding box. Both halves of that are corrections.
      //
      // A figure used to spill when it outgrew its column — into the
      // neighbouring column, the dialog's padding, or under the sticky header —
      // and that is what this file was written after. A figure *clips* now, so
      // the same overrun is silent: what it costs is the outermost thing the
      // figure draws, and the reader is shown a picture with a piece missing
      // rather than a dialog with a figure across it.
      //
      // And ink is not boxes. `centreFigureContents` measures what a figure
      // paints — see `inkRects` in HelpModal.ts — so a sample contributes the
      // 80.7 of it that is glyph and ruby rather than the 88 of column pitch it
      // is laid out in, and the foldout that rests behind a 品詞 pill at
      // `opacity: 0` contributes nothing at all. That last one is the whole
      // reason this round happened: measured as a box it is ~96px of pill
      // standing to the right of an 88px column, it carried the undo step's
      // measured right edge past the border, and the centring pulled the
      // picture left until the left-hand relation label was outside the frame.
      expect(figure.ink, `${figure.key}: ${figure.why}`).toBeLessThanOrEqual(CLIP_BOX);
    });
  }

  it("holds the widest of them clear of the clip by more than a rounding error", () => {
    // Not merely inside, but inside by enough that a few pixels moving
    // somewhere else does not put it out again. The two spills this file was
    // written after were 2px and 10.6px of ink past the border.
    //
    // The widest is the relation step, and what makes it so is that its menu is
    // drawn whole: five rows of 基本成分 wrap into five columns, 202 (ROOT's
    // own row has since left this group for a singleton category of its own,
    // which cost this figure nothing — the column count and the width were
    // already five and 202 with ROOT's row still in it), and it stands beside
    // an 88px sample with a gutter for the label in between. It was 322 — two
    // past the column — while that gutter was 2rem for a label that had been
    // recorded as 31px wide and is 14.46.
    const widest = figures().reduce((a, b) => (b.ink > a.ink ? b : a));
    expect(`${widest.key} at ${widest.ink.toFixed(1)}`).toBe(`relation at 306.7`);
    // 11.3 of slack, 5.7 of it at each edge.
    expect(CLIP_BOX - widest.ink).toBeGreaterThan(10);
  });

  it("measures the relation label off its own box rather than recalling it", () => {
    // The constant that was wrong, pinned where the derivation is. A label is
    // one line of vertical text at a fifth of the cell over a 1.2 line, with
    // `0.15rem + --mark-edge` of padding at each end, hung from its own centre
    // on the column's left edge — so half of it, and no more, is outside the
    // sample.
    expect(CHIP_EM).toBeCloseTo(17.6, 6);
    expect(LABEL_BOX).toBeCloseTo(28.92, 6);
    expect(LABEL_OVERHANG).toBeCloseTo(14.46, 6);
    // Both figures that hold a gutter open for it hold it open by more, and
    // the tighter of the two is the relation step's, which is where the two
    // pixels came from.
    expect(GUTTER).toBeGreaterThan(LABEL_OVERHANG);
    expect(PAIR_GAP).toBeGreaterThan(LABEL_OVERHANG);
  });

  it("keeps the undo step's own gaps where its two labels need them", () => {
    // The one figure that pays for its gaps asymmetrically, and the numbers it
    // pays them by. `centreFigureContents` centres what the figure paints
    // inside its padding box, so the figure's padding is a budget and not a
    // placement — which is why the `padding-right: 0.25rem` that used to stand
    // here is gone: it moved nothing, and answered to a content box no figure
    // in this dialog keeps now that the menus are drawn whole.
    const undo = figures().find((figure) => figure.key === "undo")!;
    // 2rem of clearance before the right-hand sample, which is the same answer
    // `.help-figure-pair` gives the same label, and more than it needs.
    expect(UNDO_GAP + UNDO_MARGIN).toBe(PAIR_GAP);
    expect(UNDO_GAP + UNDO_MARGIN).toBeGreaterThan(LABEL_OVERHANG);
    // Nothing stands in the gap on the left, so it is the figure's own tight
    // one — the gap `.help-figure` uses when a menu is beside its character.
    expect(UNDO_GAP).toBe(TIGHT_GAP);

    // And what that leaves at the borders, which is the number this figure was
    // reported on twice — off-centre to the left, and then with its left-hand
    // label cut off by the frame. The ink is centred in the clip box with the
    // label the leftmost thing in it, and it now stands 29.6px clear: inside
    // the 1.9rem of padding `.help-figure` keeps for exactly this label, with
    // 1.4 to spare.
    const clear = (CLIP_BOX - undo.ink) / 2;
    expect(clear).toBeCloseTo(32.24, 1);
    // Inside the 1.9rem of padding `.help-figure` keeps for exactly this label,
    // with 1.8 to spare — where the boxes, counting a foldout nobody paints,
    // had it 2.5px *outside* the border.
    expect(clear).toBeGreaterThan(FIGURE_PAD);
  });
});

describe("one box for all eight, and what it cuts", () => {
  /* **The half this file did not have, and the half the clamp made of it.**
   * Both spills this file was written after were sideways, so its figures were
   * measured across the page and not down it — and the third report was that
   * the part-of-speech step was *tall*: 619px against the 348.4 and 392.4 of
   * the other seven, with a levelling pass holding its row-mate open to match,
   * so one tall figure was two tall boxes.
   *
   * That has now been answered three times. First by abbreviating the two
   * menus, which cost the part-of-speech figure eight of its eleven entries;
   * then, the menus restored, by a clamp of 511 derived from the deepest cut
   * into that figure's menu that left no word of it shown in part; and now by
   * the reader striking that constraint out — *"reduce the diagram height
   * further; I don't care if the menu in step 4 has words cut off in the
   * middle"* — which leaves the clamp set by everything that is **not** a menu.
   *
   * So the questions here are:
   *
   *   - is every figure really the same size, which is the whole point of a
   *     clamp and is a fact about the stylesheet rather than about a measuring
   *     pass;
   *   - is the clamp clear of the deepest ink in the dialog that is not a menu
   *     — a sample, a chip, a pointer — because those are what a figure cannot
   *     lose;
   *   - and is it the *smallest* such height, since that is what was asked for.
   *
   * A clamp that was too small would not look like a bug. It would look like a
   * tidy dialog with a chip cut in half. */

  it("gives every figure the same box", () => {
    // Declared, not measured: `.help-figure` states a `height`, so there is
    // nothing for a row of the grid to even up and no way for two figures to
    // come out at different sizes. A floor would not do it — the tall figure
    // would stay tall — so the `min-height` this replaced has to be gone as
    // well as the levelling pass.
    expect(FIGURE.has("height")).toBe(true);
    expect(FIGURE.get("overflow")).toBe("hidden");
    expect(FIGURE.has("min-height")).toBe(false);

    // And no figure may take a size of its own. Three rules in app.css single
    // out one kind of figure — the paired ones, the stacked one, the undo step
    // — and any of them could quietly give its figure a different box; a
    // per-step height is exactly the thing a clamp is, and the "all the same
    // size" above would go on passing while the dialog stopped being it.
    const sized = [...withoutComments(app).matchAll(/^(\.help-figure[^{]*)\{([^}]*)\}/gm)].filter(
      ([, selector, body]) =>
        selector.trim() !== ".help-figure" && /(^|[\s;])(min-|max-)?height\s*:/.test(body),
    );
    expect(sized.map(([, selector]) => selector.trim())).toEqual([]);
  });

  it("is the larger of its two terms, and both are run rather than recalled", () => {
    // **(a) no figure may cut ink that is not a menu.** The deepest such ink is
    // a column's characters and the chip under the last of them — three
    // advances and a glyph, then 28.3 of reach — and on a figure that holds two
    // columns, the stagger between them as well.
    expect(KANJI_ADVANCE).toBe(88);
    expect(GLYPH).toBe(44);
    expect(GLYPHS_DEPTH).toBe(308);
    expect(PLAIN_INK_DEPTH).toBeCloseTo(336.3, 6);
    expect(FIGURE_CHROME).toBeCloseTo(40.4, 6);
    // Ink and not the box a sample takes: 15.7 of that box is the part of the
    // trailing gap the chip does not reach into, and cutting it costs nothing.
    expect(PLAIN_FIGURE_HEIGHT - (FIGURE_CHROME + PLAIN_INK_DEPTH)).toBeCloseTo(15.7, 6);
    // The pointer is the mark worth checking by name, being the only one that
    // hangs *below* what it points at: 37.6 of mouse under a 0.85rem margin,
    // from 72% into the last glyph. It stops three pixels inside the chip, so
    // the chip is what term (a) is measured from — and a pointer that grew past
    // it would fail here rather than quietly losing its tail to the clip.
    expect(POINTER_DEPTH).toBeCloseTo(37.6, 6);
    const pointerFoot = (SAMPLE.length - 1) * KANJI_ADVANCE + POINTER_ANCHOR * GLYPH + POINTER_DEPTH;
    expect(pointerFoot).toBeLessThan(PLAIN_INK_DEPTH);
    expect(PLAIN_INK_DEPTH - pointerFoot).toBeCloseTo(3, 1);
    const tallest = figures()
      .filter((figure) => figure.key !== "pos")
      .reduce((a, b) => (b.inkHeight > a.inkHeight ? b : a));
    expect(`${tallest.key}: ${tallest.whyTall}`).toBe("select: the two columns, staggered");
    const clearsTheInk = tallest.inkHeight + FIGURE_CHROME;
    expect(clearsTheInk).toBeCloseTo(393.15, 6);

    // **(b) a figure whose caption points at something in its menu must show
    // that thing.** The stacked figure's menu begins at `MENU_TOP` down the
    // figure, so a clamp of `MENU_TOP + r` shows `r` of its run — and `r` has to
    // reach the end of the atom the figure marks.
    const marked = markedAtom();
    const showsTheMark = MENU_TOP + marked.start + marked.extent;
    expect(showsTheMark).toBeCloseTo(425.3, 6);

    // The clamp is the larger, and is exactly the larger: it clears the ink, it
    // shows the mark, and it is not a pixel more than both of those need.
    expect(CLAMP).toBeCloseTo(Math.max(clearsTheInk, showsTheMark), 6);
    expect(CLAMP).toBeCloseTo(425.3, 6);
    // Today it is (b) that binds — which is the whole reason (b) is written
    // down. (a) alone is what produced a figure whose menu showed 11.4px of
    // heading cartouche and not one word.
    expect(showsTheMark).toBeGreaterThan(clearsTheInk);
    expect(showsTheMark - clearsTheInk).toBeCloseTo(32.15, 6);
  });

  it("centres the ink that fits and hangs the ink that does not", () => {
    // **The vertical rule has two arms, and the split is a measurement.** A
    // figure whose ink fits its box is centred in it — which is what the reader
    // asked for, and what replaced a rule that hung every sample from the top so
    // that the whole column of steps shared one text height. A figure whose ink
    // does not fit is hung from the content box's top instead, because centring
    // an overflow cuts both ends and the top end is a sample: characters,
    // readings, kaeriten, chip. That is the ink term (a) exists to protect, and
    // what it gives up at the bottom is menu, which term (b) says may be cut.
    const clipHeight = CLAMP - 2 * FIGURE_BORDER;
    const overflowing = figures().filter((figure) => figure.inkHeight > clipHeight);
    expect(overflowing.map((figure) => figure.key)).toEqual(["pos"]);
    for (const figure of figures()) {
      if (figure.key === "pos") continue;
      expect(figure.inkHeight, `${figure.key}: ${figure.whyTall}`).toBeLessThanOrEqual(clipHeight);
    }

    // The hung arm is what keeps the clamp's second term true: it puts the ink's
    // top on the content box's top, which is where the column already stood, so
    // the run of menu below is exactly what the clamp bought. Centred instead,
    // this figure would rise by half its overflow and take the marked entry off
    // the page with everything else.
    const marked = markedAtom();
    const half = (overflowing[0].inkHeight - clipHeight) / 2;
    expect(POS_MENU_RUN_SHOWN - half).toBeLessThan(marked.start + marked.extent);

    // Both arms are asked of `inkRects` rather than of which step it is, so a
    // figure that grew past its box would take the second one on its own.
    expect(help).toContain("const fits = bottom - top <= inner.bottom - inner.top;");
  });

  it("shows the marked entry whole, and two more cut through the middle", () => {
    // **What the one cut figure actually shows**, computed rather than
    // asserted: the clip is at the padding box, so the run of menu visible is
    // the clamp less everything above the table's first row.
    expect(POS_MENU_RUN_SHOWN).toBeCloseTo(60, 6);

    // A wrapped menu's columns all begin at the top of the run — nothing
    // declares `justify-content` on `.token-menu-group`, so every line starts
    // at the main-axis start, which under `writing-mode: vertical-rl` is the
    // top — so one cut crosses all five at the same depth. This is the census
    // that follows, and it is the thing the reader is shown:
    const shown = atCut(POS_MENU_RUN_SHOWN);
    //   whole: the heading, the marked entry, and the one beside it;
    expect(shown.whole).toEqual(["品詞", "動詞", "副詞"]);
    //   in part: two entries with their last character cut through, which is
    //   the concession the reader made in as many words;
    expect(shown.part).toEqual(["感嘆詞", "接尾辞"]);
    //   and the rest have not begun.
    expect(shown.absent).toEqual(["名詞", "代名詞", "助動詞", "数詞", "前置詞", "助詞", "記号"]);

    // **The marked entry is whole**, which is the clamp's second term and the
    // half of this step the prose points at: `posMenu` marks 信's own 品詞 and
    // both translations say "the current one is marked". 動詞 heads the second
    // column, so one entry of run reaches it.
    const marked = markedAtom();
    expect(marked.label).toBe("動詞");
    expect(marked.column).toBe(1);
    expect(marked.start + marked.extent).toBeLessThanOrEqual(POS_MENU_RUN_SHOWN);
    expect(shown.whole).toContain(marked.label);

    // And the first entry is not, which is worth stating because it looks like
    // an oversight and is arithmetic: 名詞 shares its column with the heading,
    // which is 60 of that column on its own, so the first column's first entry
    // is the *last* thing a shallow cut reaches rather than the first.
    expect(shown.absent).toContain("名詞");
  });

  it("puts the menu under the mark rather than under the sample's box", () => {
    // `joinMenuToPill` drops the table onto the pill's foot, across the figure
    // and now down it as well. The residue it closes is the part of the
    // trailing inter-character gap the chip does not reach into — and under a
    // clamp set by the ink above the menu, those are the only pixels of table
    // the figure has.
    expect(KANJI_ADVANCE - GLYPH - CHIP_FOOT_REACH).toBeCloseTo(15.7, 6);
    expect(help).toContain("menuEl.style.marginTop");
    // Without it the menu would begin at the sample's box instead and the clamp
    // would leave 15.7px less of it — 44.3, which is short of the 60 the marked
    // entry needs. So this pass is not a nicety either: at this clamp it is
    // what keeps the mark on the page.
    const marked = markedAtom();
    expect(POS_MENU_RUN_SHOWN - 15.7).toBeLessThan(marked.start + marked.extent);
  });

  it("keeps the two menus that stand beside a sample shorter than it", () => {
    // The other seven figures take their height from the sample, and that is
    // an assumption rather than a tautology: a menu set beside the text is a
    // flex item of the same row, and one taller than the sample would decide
    // the figure's height instead — and would now be *clipped* instead of
    // making the box taller, silently, since the box no longer grows.
    //
    // Both are well under. The relation menu's cap is floored at its tallest
    // atom, 180, and the readings menu is shorter still; the figure's content
    // box is 336.3.
    const { relation, reading } = menus();
    expect(relation.along).toBeLessThan(CLAMP - FIGURE_CHROME);
    expect(reading.along).toBeLessThan(CLAMP - FIGURE_CHROME);
  });
});

describe("the figures are stills", () => {
  /* **A figure that changes under the pointer is not a figure.** The chip row
   * in the app is the 品詞 pill alone until the pointer rests on it, when the
   * two semantic pills slide out from behind it with a stagger between them
   * (`watchSemantics` in tokenInspector.ts, `.token-subtitle-semantics` in
   * kunten.css). That is an interaction, and the tutorial's figures are
   * drawings; the reader asked for it gone from all of them and for the
   * part-of-speech step to show the unfolded row as a fact of the drawing
   * rather than as a hover left switched on.
   *
   * It is also what was breaking the centring. Folded, those pills are not
   * hidden in any sense that costs them a box — the wrapper is `position:
   * absolute; left: 100%; width: max-content` and they sit in it at `opacity:
   * 0` — so ~96px of unpainted pill stood to the right of every analysed
   * sample, and the pass that centred figures by their boxes dragged the
   * picture left to make room for it. */

  const helpRules = (selector: string) => ruleBody(app, selector);

  it("switches off every transition and animation inside a figure", () => {
    // A figure that animates into place on load is the same fault at a slower
    // speed, so this is the whole subtree and not the chips alone: the overlay
    // fades in and grows its head box over 160ms as it is drawn.
    const rule = /\.help-figure \*,[^{]*\{([^}]*)\}/.exec(withoutComments(app));
    expect(rule, "no rule stills a figure's subtree").not.toBeNull();
    expect(rule![1]).toMatch(/transition:\s*none\s*!important/);
    expect(rule![1]).toMatch(/animation:\s*none\s*!important/);
    // The whole subtree and its pseudo-elements, since the head box is one.
    expect(rule![0]).toContain("::before");
    expect(rule![0]).toContain("::after");
  });

  it("takes the pointer away from the two marks that opt back into it", () => {
    // The row's own `mouseover` is what unfolds the chips, and an overlay's
    // marks opt back into pointer events so their retag menus can be opened on
    // the page (`.token-subtitle, .token-arrow-label` in kunten.css). There is
    // no menu to open in a figure, and no hover to have.
    //
    // Matched off the file rather than through `ruleBody`, the selector being a
    // list across two lines: what has to be true is that both marks are named
    // and that what they are given is `pointer-events: none`.
    const rule = /\.help-figure \.token-subtitle,\s*\.help-figure \.token-arrow-label\s*\{([^}]*)\}/.exec(
      withoutComments(app),
    );
    expect(rule, "no rule takes the pointer off a figure's marks").not.toBeNull();
    expect(declarations(rule![1]).get("pointer-events")).toBe("none");
  });

  it("takes the folded foldout out of the layout, and wears the app's own class for the unfolded one", () => {
    // Folded: gone, not merely invisible — which is what keeps its box out of
    // the centring as well as out of the picture.
    expect(
      declarations(helpRules(".help-figure:not(.help-figure-unfolded) .token-subtitle-semantics")).get("display"),
    ).toBe("none");

    // **Unfolded: the app's own class, set on the overlay.** app.css used to
    // carry the two declarations that class resolves to — `opacity: 1` and
    // `transform: translateX(0)` — on the argument that a figure should not wear
    // an interaction's class. That was half of the reveal, and the half it left
    // out was the 品詞 pill's silhouette: the point is drawn only under
    // `.token-semantics-shown`, and at rest that pill is clipped square with
    // half a chevron trimmed off. The figure showed a blunt first pill against
    // the second one's notch and the reader reported an unrendered chevron.
    //
    // So the guard is the keying itself: the pointed polygon must be reachable
    // only through the class, and the figure must set it.
    const point = ruleBody(kunten, ".token-semantics-shown .token-subtitle-row > .token-subtitle:not(:last-child)");
    expect(point).toContain("clip-path: polygon");
    expect(ruleBody(kunten, ".token-subtitle-row > .token-subtitle:not(:last-child)")).toContain("clip-path: inset");
    expect(withoutComments(app)).not.toContain("token-semantics-shown");

    // And the figure sets it, once, on the overlay `showInspector` built — with
    // the class name pinned against the module that owns it, since HelpModal.ts
    // spells it out rather than importing a private constant.
    const inspector = readFileSync(join(ROOT, "src", "render", "tokenInspector.ts"), "utf-8");
    const owned = /const SEMANTICS_SHOWN = "([^"]+)"/.exec(inspector)![1];
    expect(new RegExp(`const SEMANTICS_SHOWN = "${owned}"`).test(help)).toBe(true);
    expect([...help.matchAll(/classList\.add\(SEMANTICS_SHOWN\)/g)]).toHaveLength(1);
    expect([...help.matchAll(/classList\.add\("help-figure-unfolded"\)/g)]).toHaveLength(1);
  });

  it("pays for the unfolded row in width, and stays inside the clip", () => {
    // 96.2 of pill standing to the right of the 品詞 pill's trailing edge —
    // two chips of two characters, each pulled back over its predecessor's
    // point by the chevron less the seam — against the menu's 202 hanging the
    // other way from the same edge.
    expect(SEMANTICS_RUN).toBeCloseTo(96.24, 2);
    const pos = figures().find((figure) => figure.key === "pos")!;
    expect(pos.ink).toBeCloseTo(298.24, 2);
    expect(pos.ink).toBeLessThanOrEqual(COLUMN - 2 * FIGURE_BORDER);
  });
});

describe("where a figure puts the menu it draws", () => {
  /* Three menus, three placements, and each of them is the app's own — which is
   * the rule this dialog is built on and the one it has been corrected against
   * twice. A menu drawn where one never opens teaches the wrong place to look.
   *
   *   - the **category** menu is subjoined to its pill, and the figure stacks;
   *   - the **relation** menu is left-joined to its label, and the figure sets
   *     it beside the text in the same gutter the label stands in;
   *   - the **readings** menu is dropped at the pointer, and the figure now
   *     drops it there too, across the characters. It used to stand in the flow
   *     to the left of the text on the argument that a 320px figure could
   *     honestly derive the side and not the coordinates; the reader answered
   *     that — *"the readings menu should appear where it normally would, even
   *     though this would obscure the text"*. */

  it("drops the readings menu at the same point the pointer's tip is drawn at", () => {
    expect(declarations(ruleBody(app, ".help-figure-dropped .token-context-menu")).get("position")).toBe("absolute");
    // One figure, and only one, is placed rather than laid out.
    expect([...help.matchAll(/classList\.add\("help-figure-dropped"\)/g)]).toHaveLength(1);
    expect([...help.matchAll(/dropMenuAtPointer\(/g)].length).toBeGreaterThanOrEqual(2);

    // The top right corner at the point clicked, which is what `menuTopLeftFor`
    // does with an event's coordinates — reaching its own width to the left and
    // its height down — and the point is `POINTER_TIP` into the ruby, the same
    // fraction the pointer beside it is drawn from. A menu that appeared a few
    // pixels off its own cursor would be a figure disagreeing with itself about
    // where the click was.
    expect(help).toContain("t.left + t.width * POINTER_TIP - box.left - menu.width");
    expect(help).toContain("t.top + t.height * POINTER_TIP - box.top");

    // So the figure's ink is the menu and the pointer end to end, and the
    // sample it covers is inside both.
    const reading = figures().find((figure) => figure.key === "reading")!;
    expect(reading.ink).toBeCloseTo(menus().reading.width + POINTER_WIDTH, 6);
    expect(reading.ink).toBeCloseTo(163.6, 1);
    expect(reading.ink).toBeLessThan(COLUMN - 2 * FIGURE_BORDER);
    // And it keeps the lift the page gives it, which is what says a menu is on
    // top of the text rather than in it.
    expect(declarations(ruleBody(app, ".help-figure:not(.help-figure-dropped) .token-context-menu")).get("box-shadow")).toBe("none");
  });

  it("keeps the relation menu within a few pixels of its own join", () => {
    // The figure sets this one in the flow, `GUTTER` left of the sample. On the
    // page it is left-joined to the label — `MENU_JOIN_GAP` clear of the
    // label's left edge — and the label hangs `LABEL_OVERHANG` past the sample.
    // So the flow arrangement is not a compromise with the truth; it lands 3.5px
    // outside it.
    expect(GUTTER - (LABEL_OVERHANG + MENU_JOIN_GAP)).toBeCloseTo(3.54, 2);
    expect(GUTTER).toBeGreaterThan(LABEL_OVERHANG);
  });
});

describe("the two columns of a figure that holds two", () => {
  /* **The stagger.** Two columns of vertical text set at the same height read
   * as one column with a gap in it. The figures that hold two offset the second
   * — and they do it by one rule and not by a second mechanism: the column that
   * *begins* a figure hangs from the top (`align-self: flex-start`) and whatever
   * is beside it is centred against it, by the figure's own `align-items:
   * center` or by an aside's `justify-content: center`. */

  it("hangs only the column that begins a figure", () => {
    // `:first-child` is the correction. The rule used to name every kanbun
    // sample in a figure; on the figures whose second thing sits in an aside
    // that made no difference, since an `align-self` in there is the aside's
    // own cross axis. The undo step appends its three parts to the figure
    // directly, so both its samples took the rule, both hung from the top, and
    // it was the one two-column figure with no stagger.
    const hung = [...withoutComments(app).matchAll(/^(\.help-figure[^{]*\.help-sample[^{]*)\{([^}]*)\}/gm)].filter(
      ([, , body]) => /align-self:\s*flex-start/.test(body),
    );
    expect(hung).toHaveLength(1);
    expect(hung[0][1]).toContain(":first-child");
    // And not the stacked figure, whose cross axis is the horizontal one and
    // whose column is flush right with the menu below it.
    expect(hung[0][1]).toContain(":not(.help-figure-menu-below)");
    expect(declarations(ruleBody(app, ".help-figure-menu-below > .help-sample:has(> .text-main)")).get("align-self")).toBe(
      "flex-end",
    );
  });

  it("offsets the second column by half the room the first does not use", () => {
    // Not a declared number: it is what "one hangs, the other is centred" comes
    // to, and it moves with the box.
    expect(STAGGER).toBeCloseTo((CONTENT_HEIGHT - SAMPLE_HEIGHT) / 2, 6);
    expect(STAGGER).toBeCloseTo(16.45, 6);
    // It costs the clamp's first term exactly that much, since a staggered pair
    // is one column's ink plus the offset — which is why the term is 393.15
    // where a single column would make it 376.7.
    const staggered = figures().filter((figure) => figure.whyTall.includes("staggered"));
    expect(staggered.map((figure) => figure.key)).toEqual(["select", "head", "undo"]);
    for (const figure of staggered) {
      expect(figure.inkHeight - PLAIN_INK_DEPTH).toBeCloseTo(STAGGER, 6);
    }
  });
});

describe("what the step's own prose points at in the figure beside it", () => {
  /* **A reader shown a label they cannot find** is the fault this figure was
   * rebuilt to answer, and it has happened twice. The relation figure used to
   * be four hand-built entries out of `deprelJa`, so it read 斜格補語 where the
   * menu read 斜格補語〖場所〗; and the step's prose named a bracketed relation
   * as its example of the convention, which for a while was one the figure's
   * own rows no longer contained — 補語〖形式〗 replaced 斜格補語〖場所〗 in the
   * copy when `comp:obl` was re-filed out of 基本成分, and the copy was chased
   * after the fact.
   *
   * Both are the same mistake: the figure and the sentence under it are
   * maintained in different files and nothing made them agree. This is what
   * makes them agree. The prose in both languages writes its example inside a
   * 〖…〗, so the example can be read straight out of the translation and looked
   * for in the rows `deprelMenu` actually draws — and a change on either side
   * that parts them fails here.
   *
   * Both languages, because they are two files and a fix to one is not a fix to
   * the other. */

  const i18n = (lang: string) =>
    JSON.parse(readFileSync(join(ROOT, "src", "i18n", `${lang}.json`), "utf-8")) as Record<string, string>;

  /** The bracketed relation a step's prose holds up as its example — the run of
   * label characters ending in a 〗, which is how both translations write one. */
  const bracketedExample = (body: string) => /[^\s、。「」—–-]*〖[^〗]*〗/.exec(body)?.[0];

  for (const lang of ["en", "ja"]) {
    it(`names a relation the figure draws, in ${lang}`, () => {
      const body = i18n(lang)["help.step.relation.body"];
      expect(body, `${lang}: no help.step.relation.body`).toBeTruthy();
      const example = bracketedExample(body);
      expect(example, `${lang}: the step names no 〖…〗 example`).toBeTruthy();

      // Drawn by the figure, as `deprelRowElement` writes it: the row's own
      // segments joined, brackets and all. The figure shows the whole of the
      // first category now, so this is a real question again — under the
      // abbreviation it was two rows of six, and the copy had to be written
      // around the cut.
      const drawn = deprelRowsShown().rows.map((row) => row.segments.map((seg) => seg.text).join(""));
      expect(drawn, `${lang}: ${example} is not among the rows the figure draws`).toContain(example);
    });
  }

  it("leaves the part-of-speech step's own claim to the clamp", () => {
    // That step's prose points at something in its figure too — *"the current
    // one is marked"* / 「現在のものに印が付きます」 — but what it points at is a
    // mark on an entry rather than a label a reader could look up, so the tie
    // between copy and figure there is geometric and is asserted where the
    // geometry is: the clamp's second term exists to keep that entry on the
    // page, and `markedAtom` is what computes it. This line is here so that a
    // reader following the copy arrives at it.
    for (const lang of ["en", "ja"]) {
      const body = i18n(lang)["help.step.pos.body"];
      expect(body, `${lang}: no help.step.pos.body`).toBeTruthy();
      expect(body, `${lang}: the step no longer claims a mark`).toMatch(/marked|印/);
    }
    expect(markedAtom().label).toBe("動詞");
  });

  it("shows that example where the clamp does not cut it", () => {
    // The figure is clipped — a pixel off each edge (see above) — so "in the
    // figure" has to mean "in the part of the figure that survives". The row
    // the copy names is 補語〖形式〗, the last atom of the category and so the
    // last of the five columns, which a vertical menu lays out furthest to the
    // *left*: exactly the edge the clip takes its pixel from. What it takes is
    // the menu's 匡郭, and the table's own 四分 of padding stands between that
    // and any glyph.
    const example = bracketedExample(i18n("en")["help.step.relation.body"])!;
    const rows = deprelRowsShown().rows;
    const which = rows.findIndex((row) => row.segments.map((seg) => seg.text).join("") === example);
    expect(which).toBe(rows.length - 1);
    // Nothing of it is cut down the page either: the whole table stands beside
    // the sample and is shorter than it.
    expect(menus().relation.along).toBeLessThan(SAMPLE_HEIGHT);
    // And the pixel the clip takes on that side is under the padding the menu
    // keeps inside its border, so no glyph of that column is touched.
    expect((menus().relation.width + GUTTER + PITCH - COLUMN) / 2).toBeLessThanOrEqual(
      menuTwoUp(MENU.get("padding")!).leftright + lengthOf(MENU.get("border")!.split(" ")[0]),
    );
  });
});

describe("where the menus join their marks", () => {
  // The figures derive their layout from `menuAnchorFor`, which is the
  // function the panel itself anchors by (`joinsBelow`, HelpModal.ts). These
  // pin the two answers the tutorial is laid out from, because the
  // part-of-speech figure's whole fit depends on being stacked rather than set
  // beside the text — and because a figure that took the wrong one would be
  // teaching a placement the app does not have.
  //
  // **Asked with the standoff taken out.** A join is no longer flush — every
  // menu now stands `MENU_JOIN_GAP` off its mark, along the axis of its own
  // join — so the bare corner is what has to be asked for here, exactly as
  // `joinsBelow` asks for it. Passing the gap explicitly as 0 is that
  // question; the gap's own arithmetic is pinned in tests/menuAnchor.test.ts,
  // and it costs these figures nothing, a figure drawing its join from its own
  // rules in app.css rather than from a coordinate.
  const mark: Extent = { left: 0, top: 0, right: 1, bottom: 1 };
  const below = (kind: RetagKind) => menuAnchorFor(kind, mark, 0).y === mark.bottom;

  it("subjoins every category menu to its pill", () => {
    for (const kind of ["pos", "domain", "sense"] as RetagKind[]) {
      expect(below(kind), kind).toBe(true);
      expect(menuAnchorFor(kind, mark, 0).x, kind).toBe(mark.right);
    }
  });

  it("left-joins the relation menu to its label", () => {
    expect(below("dep")).toBe(false);
    expect(menuAnchorFor("dep", mark, 0)).toEqual({ x: mark.left, y: mark.top });
  });

  it("stands every menu off its mark, and only along the axis it joins on", () => {
    // The gap the reader asked for, checked here as well because this is the
    // file that knows the tutorial reads these coordinates: a gap that leaked
    // into the other axis would move a figure's join sideways as well as away,
    // and `joinsBelow` above would be asking about a corner that no longer
    // exists.
    for (const kind of ["pos", "domain", "sense"] as RetagKind[]) {
      expect(menuAnchorFor(kind, mark).x, kind).toBe(menuAnchorFor(kind, mark, 0).x);
      expect(menuAnchorFor(kind, mark).y - mark.bottom, kind).toBe(MENU_JOIN_GAP);
    }
    expect(menuAnchorFor("dep", mark).y).toBe(mark.top);
    expect(mark.left - menuAnchorFor("dep", mark).x).toBe(MENU_JOIN_GAP);
  });
});

describe("what the deprel label's sideways dodge can cost a figure", () => {
  /* The suspect this round began with, cleared here rather than in a comment
   * alone, because it is the thing anyone would look at first and because the
   * arithmetic that clears it is short.
   *
   * `decollideOverlay` steps the label out of the *inspected token's own*
   * ruby's way, and does it with a wall of ±Infinity — deliberately, so that
   * the label clears the ruby completely rather than half-clearing it. An
   * unbounded sideways step in a 320px figure would be exactly the kind of
   * thing that puts ink past a border.
   *
   * It cannot fire in this panel, and the reason is which lane a reading
   * stands in. Measured out from a glyph's own centre at the shipped 88px
   * advance (the table is in tests/inspectorLayout.test.ts): the kunten lane
   * is −44…−22, the glyph −22…22, and *both* reading lanes are on the other
   * side — 22…44 for the character's own, and rule 5's overflow lane a further
   * kana out on the same side again (`.reading-outside > rt` is `left: calc(100%
   * + …)`, which kunten.css's 傍線 note leans on for its own placement). The
   * arc is bowed left for precisely that reason, so the label stands in the
   * kunten lane with every reading it could be asked about on the far side of
   * the glyph.
   *
   * `labelStandoff`'s first test is `box.left >= moved.right`, "already clear
   * across". The label's painted trailing edge stands at −29 from the centre
   * and the nearest reading's leading edge at +22, so that test passes for
   * every obstacle on every pass and the loop breaks having moved nothing. The
   * step is 0, and the 31px `LABEL_OVERHANG` records is the label where the
   * arc's midpoint put it.
   *
   * The walled second pass, for a revealed foldout, is `0` here for a
   * different reason: the figures are `pointer-events: none` and nothing in
   * them is ever hovered, so `SEMANTICS_SHOWN` is never set and the obstacle
   * list is empty. */

  it("has no ruby on the label's side of the glyph to dodge", () => {
    const HALF_GLYPH = lengthOf(TYPE.get("--size-main")!, { em: REM }) / 2;
    // The lane the label stands in, and the lane the nearest reading does.
    const labelSide = -PITCH / 2;
    const readingSide = HALF_GLYPH;
    expect(labelSide).toBeLessThan(0);
    expect(readingSide).toBeGreaterThan(0);
    // A reading is `left: 100%` of its glyph — outside the glyph's own right
    // edge — and rule 5 sends an overflowing one further out on the same side,
    // so no obstacle the label is offered ever begins left of the glyph.
    expect(declarations(ruleBody(kunten, ".kanji-cell rt", "writing-mode")).get("left")).toContain("100%");
    expect(ruleBody(kunten, ".reading-outside > rt")).toContain("100%");
  });
});





