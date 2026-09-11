import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { rimeAnchors, warichuColumns } from "../src/render/rimeAnnotation.ts";

// ---------------------------------------------------------------------------
// Where the 割注 hangs, checked as far as a checkout with no browser can check
// it — which is further than it looks, because the bug this block exists for
// was never visible in a browser either until someone looked at the page.
//
// **The reader's report was "the warichū are not centred below the kanji", and
// two different faults produce exactly that.**
//
//  1. The box measured against the wrong thing. It was an inline-block in the
//     run of the line with `vertical-align: top`, which pins a box's line-over
//     edge to the *line box's* line-over edge — the right-hand side of the
//     column under `vertical-rl`. The line box is `--column-pitch` thick and
//     the character is `--size-main`, so the gloss sat clear of the ink by half
//     the annotation lanes. It is now out of flow against `.kanji-glyph`.
//
//  2. An unresolvable `var()` inside `transform`. This is the fault
//     `tests/inspectorLayout.test.ts`'s "every custom property a mark uses is
//     one it can see" was written for: `--chip-chevron` was declared on a
//     *descendant* of the rule that used it, custom properties inherit
//     downward only, and the whole `transform` declaration went invalid at
//     computed-value time — taking `translateX(-50%)` with it and hanging the
//     row off the glyph's centre by its left edge. The symptom is identical to
//     (1). This block borrows that test's shape, which is what it is for.
//
// What can be checked without a browser is reachability and literalness: every
// property a rule uses is declared on that rule or on an ancestor, and the
// centring is expressed in numbers that cannot fail to resolve.
// ---------------------------------------------------------------------------

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (...parts: string[]) => readFileSync(join(ROOT, ...parts), "utf-8");
const rime = read("src", "render", "rime.css");
const app = read("src", "app.css");
const typography = read("src", "render", "typography.css");
const kunten = read("src", "render", "kunten.css");
const annotation = read("src", "render", "rimeAnnotation.ts");

/** One rule's body, comments stripped — a note *about* a declaration must not
 * be read as one, which is the trap a plain `indexOf` falls into here: this
 * stylesheet's comments quote the very properties and values the assertions
 * are about. */
function blockFor(sheet: string, selector: string): string {
  const at = sheet.indexOf(`\n${selector} {`);
  if (at < 0) return "";
  return sheet.slice(at, sheet.indexOf("\n}", at) + 2).replace(/\/\*[\s\S]*?\*\//g, "");
}
const declaredIn = (sheet: string, selector: string): string[] =>
  [...blockFor(sheet, selector).matchAll(/^ +(--[a-z0-9-]+) *:/gm)].map((m) => m[1]);
const usedIn = (sheet: string, selector: string): string[] =>
  [...blockFor(sheet, selector).matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]);

describe("every custom property the rime gloss uses is one it can see", () => {
  it("finds the rules it is meant to be checking", () => {
    // The guard's own guard, as the inspector's block has: a selector lookup
    // that quietly stopped matching would make every assertion below vacuous,
    // which is the shape of the bug this file exists for.
    expect(blockFor(rime, ".rime-warichu")).not.toBe("");
    expect(blockFor(rime, ".rime-warichu-line")).not.toBe("");
    expect(usedIn(rime, ".rime-warichu").length).toBeGreaterThan(0);
  });

  it("resolves all of them from `:root`, which is an ancestor of every cell", () => {
    // `--size-main` and `--kanji-gap` are declared on `:root` in typography.css
    // and `--color-kunten` on `:root` in app.css — deliberately, and both files
    // say so where they declare them ("a grid row is an ancestor of the panel,
    // so it cannot read a property the panel declares"). The gloss is a
    // descendant of `.kanji-glyph`, which is a descendant of the column, which
    // is a descendant of `:root`, so it sees all of them.
    const root = [...declaredIn(typography, ":root"), ...declaredIn(app, ":root")];
    const own = declaredIn(rime, ".rime-warichu");
    const unreachable = usedIn(rime, ".rime-warichu").filter((n) => !root.includes(n) && !own.includes(n));
    expect(unreachable.join(", ")).toBe("");
    // And named, so that moving one onto a cell or a glyph — where this
    // element could still see it, but a print band could not rewrite it — is a
    // deliberate act rather than a slip.
    expect(usedIn(rime, ".rime-warichu").sort()).toEqual(["--color-kunten", "--kanji-gap", "--size-main", "--size-main", "--size-main"]);
  });
});

describe("the centring", () => {
  const block = blockFor(rime, ".rime-warichu");

  it("is expressed in literals, so no `var()` can take the transform down with it", () => {
    // The chip row's bug, ruled out by construction: there is no `var()` in
    // this element's `transform` at all, so there is nothing in it that can
    // fail to resolve and drop the declaration to `none`.
    const transform = /transform: *([^;]+);/.exec(block)?.[1];
    expect(transform).toBe("translateX(-50%)");
    expect(transform).not.toContain("var(");
  });

  it("hangs the box off the glyph's own centre, a whole cell below it", () => {
    // 50% of the *containing block* — the glyph — less 50% of this box, which
    // is the standard centring pair and the one `.token-subtitle-row` uses.
    // Under `vertical-rl` the physical top-to-bottom axis is still the
    // direction the column runs in, so `top` is how far down the column.
    expect(block).toContain("position: absolute;");
    expect(block).toContain("left: 50%;");
    // **`100% + var(--kanji-gap)`, and never a bare `100%`.** That is the
    // reader's fourth report — "Qieyun warichū should be in the next cell, not
    // take up room needed for kaeriten!" — and a bare 100% is exactly the
    // regression: it is the character's foot, which is where `.kunten-glyph`
    // and `.odoriji` both start.
    expect(block).toContain("top: calc(100% + var(--kanji-gap));");
    expect(block).not.toMatch(/^ +top: 100%;$/m);
  });

  it("clears the lane the kaeriten and the 踊り字 share, by kunten.css's own numbers", () => {
    // The measurement is that file's, quoted so that a change to it here shows
    // up as a disagreement rather than as a silent overlap: a kaeriten is
    // `top: 100%`, `left: 0` and one em of `--size-kunten`; the 踊り字 mirrors
    // it from the right edge; between them a third of the gap is left clear.
    // The gloss now begins a whole `--kanji-gap` past all of it.
    const kaeriten = blockFor(kunten, ".kunten-glyph");
    expect(kaeriten).toContain("top: calc(100% + var(--head-box-reach, 0px));");
    expect(kaeriten).toContain("left: 0;");
    expect(kunten).toContain("13.33px of the gap is left clear");
    // A gap is a whole character (`--kanji-gap-ratio: 1`), so stepping one
    // clears a 16px kaeriten, a 14.67px 踊り字 and the 6px a boxed head adds,
    // out of 44 at the shipped scale.
    expect(typography).toContain("--kanji-gap-ratio: 1;");
  });

  it("needs a column one character longer than the poem's line, and says so", () => {
    // **The one bound out-of-flow placement buys at a price.** The gloss ends
    // (lineLength + 1) advances from the top of its column and `.tategaki` is
    // `overflow-y: hidden`, so a column shorter than that clips it: six
    // characters for a 五言, eight for a 七言 — 528px and 704px at the shipped
    // 88px advance. Stated here because there is no browser to observe it in,
    // and an unobserved bound that is written down is worth more than one that
    // is assumed away.
    const advance = 44 + 44; // --size-main 2.75rem, --kanji-gap x1
    expect((5 + 1) * advance).toBe(528);
    expect((7 + 1) * advance).toBe(704);
    // Matched with the comment's own line wrapping folded out, so that a
    // reflow of the prose is not a test failure.
    expect(rime.replace(/\s*\n \* ?/g, " ")).toContain("six for a 五言, eight for a 七言");
  });

  it("is exactly the glyph's own width, so centring the box centres the ink", () => {
    // **The claim `translateX(-50%)` rests on.** Half of *this box* is only the
    // right amount to come back by if the box is the character's width. It is:
    // two columns, each `--size-main / 2` thick because that is the font-size
    // and `line-height` is 1, so the pair is `--size-main` — one character. A
    // box that reserved more than its ink filled would centre the box and leave
    // the mark off, which is the other half of the reader's report.
    expect(block).toContain("font-size: calc(var(--size-main) / 2);");
    expect(block).toContain("line-height: 1;");
    // **Stated, not inferred.** The pair would come to one character on its own,
    // but only if an engine resolves an out-of-flow box's automatic cross size
    // across a writing-mode change the way that reasoning assumes — and there
    // is no browser here to confirm it. `translateX(-50%)` is half of this box,
    // so the whole centring rests on this number being exactly the glyph's.
    expect(block).toContain("width: var(--size-main);");
    expect(blockFor(rime, ".rime-warichu-line")).toContain("display: block;");
    // Two columns and never three: the string is split in script, so the count
    // is a fact about `warichuColumns` and not about how a box happens to wrap.
    expect(warichuColumns("侵韻")).toHaveLength(2);
    // The two-rime label, which is the widest the index can produce and so the
    // only case that puts two glyphs in a column. `海・代韻` stood here until
    // the labels were made uniformly 2 or 4 characters; it split 2 as well, so
    // this assertion went on passing while citing a string the app had stopped
    // producing — which is worth a word, because a test that still passes is
    // exactly the kind that keeps a stale example alive.
    expect(warichuColumns("海代二韻")).toHaveLength(2);
  });

  it("stands in a cell's own footprint and costs the column no advance", () => {
    // One character long and one across — the same footprint a `.kanji-cell`
    // has — standing where the next cell would. Out of flow, so no character
    // moves and the column does not grow: `advanceDown` in printLayout.ts
    // counts a page at one `--kanji-advance` per character and stays true,
    // which an in-flow gloss would have made stale on every verse line.
    expect(block).toContain("height: var(--size-main);");
    expect(block).not.toContain("margin-bottom");
    expect(typography).toContain("--kanji-gap-ratio: 1;");
    expect(typography).toContain("--kanji-advance: calc(var(--size-main) + var(--kanji-gap));");
  });
});

describe("the anchor the CSS assumes is the one the script uses", () => {
  it("appends into `.kanji-glyph`, which kunten.css keeps positioned", () => {
    // **A cross-file invariant, and the reason it is pinned here.** The gloss
    // is `position: absolute` and its containing block is whichever ancestor
    // is positioned; kunten.css gives `.kanji-glyph` `position: relative` for
    // the kaeriten's sake. Were that to go, this box would fall back to
    // `.tategaki-column` — which is also `position: relative` — and every gloss
    // in the poem would pile up at one place on the page rather than throwing.
    expect(annotation).toContain('querySelector<HTMLElement>(".kanji-glyph")');
    expect(blockFor(kunten, ".kanji-glyph")).toContain("position: relative;");
  });

  it("is not the cell, which is wider than the character by the reading's lane", () => {
    // `.token-subtitle-row` places itself from "the glyph's own horizontal
    // centre (not the wider ruby-inclusive `.kanji-cell`)" and this is the same
    // fact used for the same purpose. Centring on the cell would have been the
    // reader's complaint again, wearing a different number.
    expect(kunten).toContain("not the wider ruby-inclusive");
    expect(annotation).not.toContain('insertAdjacentElement("afterend"');
  });

  it("counts its anchors over every cell on the page, heading included", () => {
    // The DOM walk collects `.kanji-cell`s across the whole column, so the
    // anchors have to be indexes into all of them — `offset` is what carries
    // the title. The arithmetic is checked against the real sample in
    // `tests/rimeDetector.test.ts`; what is checked here is that the offset is
    // added at all, which is the one-line slip that would put every gloss on
    // the wrong character.
    const fake = { lines: [[1, 2], [3, 4]], lineLength: 2, rhyme: [], startLine: 1, offset: 7 } as never;
    expect(rimeAnchors(fake)).toEqual([8, 10]);
  });
});

describe("the stylesheet is loaded, and after the one it reads from", () => {
  it("is imported by app.css below kunten.css", () => {
    const imports = [...app.matchAll(/@import "([^"]+)"/g)].map((m) => m[1]);
    expect(imports).toContain("./render/rime.css");
    expect(imports.indexOf("./render/rime.css")).toBeGreaterThan(imports.indexOf("./render/kunten.css"));
  });

  it("goes out with the rest of the apparatus, by the switch's own mechanism", () => {
    // `filter: opacity(0)` and not `display: none`: kunten.css hides the
    // kaeriten that way so that nothing on the page moves when the switch is
    // thrown, and this follows it rather than inventing a second answer.
    expect(blockFor(rime, "body.hide-kunten .rime-warichu")).toContain("filter: opacity(0);");
    expect(kunten).toContain("filter: opacity(0);");
  });
});
