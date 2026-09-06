import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { REREAD_CHARACTERS } from "../src/kakikudashi/rereadCharacters.ts";
import { NEGATION } from "../src/kakikudashi/bungoConjugation.ts";

// ---------------------------------------------------------------------------
// **The two lanes a 再読文字 stands between, said as arithmetic.**
//
// A 再読文字 is read twice: the first reading is the furigana in the lane on
// the character's right (`.kanji-cell rt`), the second is written down the
// lane on its left (`.reread-second`). Two runs of kana, one character, and
// the only thing a reader can check at a glance is whether they are placed
// alike — which is what was asked for, and which the left rule was not doing.
// It centred its run in the *lane* rather than placing it against the
// character, so its near edge stood M/12 clear of the glyph where the right
// one stood flush: 3.67px at the shipped scale, against 0.
//
// There is no browser in this suite and no layout in it. What there is, is
// two declarations written entirely in `--size-main` and `--size-furigana` —
// so the relation between them either holds at every type scale or holds at
// none, and an evaluator over the stylesheet settles which. The evaluator is
// the same one `panelMargins.test.ts` and `conjClassCartouche.test.ts` use,
// and it reads the declarations out of the file the browser reads them out
// of, so an agreement here is an agreement with the page.
//
// Everything below is computed at **two** type scales, because a single set
// of pixels would pass just as happily on a rule that had the shipped numbers
// hard-coded into it. What is being checked is the relation.
//
// ── The frame the figures are in ──────────────────────────────────────────
// x runs across the column, 0 at the character's left edge, so the character
// spans [0, M]. `line-height: 2` gives the column a pitch of 2M with the
// character centred in it (see typography.css), which leaves a lane of M/2 on
// each side: [M, 3M/2] for the reading, [-M/2, 0] for the second reading. The
// column to the left has its character at [-2M, -M] and its own reading in
// [-M, -M/2], which is the only thing this run can meet across a boundary.
//
// What no arithmetic here can settle is what the page looks like: whether the
// left run reads as belonging to its character now that it is flush against
// it, and how がごとし looks with a third of its run standing above the
// character's top. Those are the reader's.
// ---------------------------------------------------------------------------

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const kunten = readFileSync(join(SRC, "render", "kunten.css"), "utf-8");
const typography = readFileSync(join(SRC, "render", "typography.css"), "utf-8");

/** The root font size every `rem` in these files resolves against. Nothing in
 * the app sets one, so it is the UA's, and 16 is what every engine ships. */
const REM = 16;

const withoutComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");

/** The body of the first top-level rule with exactly this selector, optionally
 * the first whose body contains `contains` — the same reader the other two
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

/** The type scale, and the head box's own geometry — declared on `:root` in
 * two different files, both ancestors of every annotation that reads them, so
 * the cascade hands a rule both and this map is that flattened. */
const ROOT = new Map([
  ...declarations(ruleBody(typography, ":root")),
  ...declarations(ruleBody(kunten, ":root", "--head-box-size")),
]);

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

/** One CSS length in pixels, in the vocabulary these four declarations are
 * written in: `var()` with its fallback, `calc()`, `max()`, `min()`, and
 * lengths in `px` and `rem`.
 *
 * `percent` is what a `%` resolves against. The one rule here that uses one is
 * `.kanji-cell rt`, whose containing block is `.kanji-cell ruby` — given
 * `line-height: 1` expressly so that its box is the character and `left: 100%`
 * is the character's own right edge (see the rule, which argues it). So the
 * percentage basis is M. */
function lengthOf(
  expr: string,
  { percent = 0, vars = {} as Record<string, string> } = {},
): number {
  const lookup = (name: string) => vars[name] ?? ROOT.get(name);
  let text = expr;
  for (let round = 0; text.includes("var("); round++) {
    if (round > 20) throw new Error(`var() cycle in ${expr}`);
    text = rewriteCalls(text, "var", ([name, fallback]) => {
      const value = lookup(name);
      if (value !== undefined) return `(${value})`;
      if (fallback !== undefined) return `(${fallback})`;
      throw new Error(`unresolved ${name}`);
    });
  }
  text = text.replace(/\bmax\(/g, "Math.max(").replace(/\bmin\(/g, "Math.min(").replace(/\bcalc\(/g, "(");
  text = text
    .replace(/(\d*\.?\d+)rem\b/g, (_, n: string) => `(${Number(n) * REM})`)
    .replace(/(\d*\.?\d+)px\b/g, "$1")
    .replace(/(\d*\.?\d+)%/g, (_, n: string) => `(${(Number(n) / 100) * percent})`);
  // eslint-disable-next-line no-new-func
  const value = Function(`"use strict"; return (${text});`)() as number;
  if (!Number.isFinite(value)) throw new Error(`${expr} came to ${value}`);
  return value;
}

const RT = declarations(ruleBody(kunten, ".kanji-cell rt", "writing-mode"));
const SECOND = declarations(ruleBody(kunten, ".reread-second"));

/** The two type scales every figure below is computed at. The shipped one, and
 * one that is neither a multiple nor a rounder number than it — a relation
 * written in `--size-main` holds at both or it is not a relation. */
const SCALES = [
  { name: "the shipped scale", size: "2.75rem" },
  { name: "a larger scale", size: "3.5rem" },
] as const;

/** The one property on the page that moves either lane across the column: the
 * box the analysis draws round a head character. 0 on every other character,
 * and `--head-box-size + --head-box-halo` on a boxed one (see `.kanji-cell`,
 * where the sum is declared, and `.token-cell-head`, which supplies the parts).
 */
const REACH = ["0px", "calc(var(--head-box-size) + var(--head-box-halo))"] as const;

interface Lane {
  /** The character's height, and the width of its box across the column. */
  M: number;
  /** One kana of annotation: `--size-furigana`, which is M/3. */
  f: number;
  /** Half the column's leading, which is what a lane is. */
  lane: number;
  /** The step this character's own box asks its annotations for. */
  reach: number;
  /** Nearest and furthest edge of the first reading, x increasing rightward. */
  right: { near: number; far: number };
  /** Nearest and furthest edge of the second reading. */
  left: { near: number; far: number };
  /** Where the run starts and ends down the column, 0 at the character's top
   * and M at its foot. */
  run: { top: number; bottom: number };
}

/** Both lanes of one 再読文字, evaluated out of the stylesheet.
 *
 * `neighbourReach` is the box on the character in the column to the *left*,
 * whose own first reading is the only thing this run can meet across a column
 * boundary — it steps that reading toward this one, so the two boxes are
 * independent and the worst case is both. */
function laneAt(size: string, reach: string, kana = 1): Lane {
  const vars = { "--type-max-size": size, "--head-box-reach": reach, "--reread-run": String(kana) };
  const at = (expr: string, percent = 0) => lengthOf(expr, { vars, percent });
  const M = at("var(--size-main)");
  const f = at("var(--size-furigana)");
  // `left: calc(100% + …)` on a run one kana wide, growing rightward.
  const rightNear = at(RT.get("left")!, M);
  // `left: calc(-1 * …)` on a run one kana wide, its box growing rightward
  // from the offset the rule names — so the offset is the *far* edge.
  const leftFar = at(SECOND.get("left")!, M);
  const top = lengthOf(SECOND.get("top")!, {
    vars: { ...vars, "--reread-length": SECOND.get("--reread-length")! },
  });
  return {
    M,
    f,
    lane: M / 2,
    reach: at("var(--head-box-reach)"),
    right: { near: rightNear, far: rightNear + f },
    left: { near: leftFar + f, far: leftFar },
    run: { top, bottom: top + kana * f },
  };
}

/** The right edge of the left neighbour's own first reading — the run this one
 * has to stay clear of. That character sits at [-2M, -M], and its reading is
 * placed by the same `.kanji-cell rt` rule against its own right edge. */
function neighbourReading(l: Lane, neighbourReach: number): number {
  return -l.M + neighbourReach + l.f;
}

/** Every length a second reading can come to, taken from the two places that
 * decide it rather than transcribed. `REREAD_CHARACTERS` holds what the table
 * says; `rereadSecondReading` returns that, or — for the two entries that
 * negate — the ざり paradigm's 連体形 where an attributive particle follows.
 * `cellFor` sets `--reread-run` from the length of whichever it got. */
const RUN_LENGTHS = [
  ...new Set([...Object.values(REREAD_CHARACTERS).map((e) => e.second.length), NEGATION.rentaiZari!.length]),
].sort((a, b) => a - b);

describe("the two readings of a 再読文字, across the column", () => {
  for (const { name, size } of SCALES) {
    for (const reach of REACH) {
      const boxed = reach === "0px" ? "unboxed" : "boxed";
      const l = laneAt(size, reach);

      it(`stands the left reading the same distance from the character as the right (${name}, ${boxed})`, () => {
        // The whole of what was asked for. "Distance from the kanji" is the
        // gap between the character's own edge and the near edge of the run
        // beside it — and the right one has always been flush, so this is 0
        // unboxed and the box's reach when the box is up.
        expect(l.left.near - 0).toBeCloseTo(-(l.right.near - l.M), 10);
        expect(l.M - l.right.near).toBeCloseTo(-l.reach, 10);
        expect(l.left.near).toBeCloseTo(-l.reach, 10);
      });

      it(`steps both readings by the same reach, so a boxed 再読文字 stays symmetrical (${name}, ${boxed})`, () => {
        const unboxed = laneAt(size, "0px");
        expect(l.right.near - unboxed.right.near).toBeCloseTo(l.reach, 10);
        expect(unboxed.left.far - l.left.far).toBeCloseTo(l.reach, 10);
      });

      it(`leaves each run the same room at the outer edge of its lane (${name}, ${boxed})`, () => {
        // The lane is M/2 and the run is f = M/3, so what is left over is
        // M/6 less whatever the box took — 7.33px unboxed at the shipped
        // scale, and the 1.33px `.kanji-cell rt` measures once it is up.
        const spareRight = l.M + l.lane - l.right.far;
        const spareLeft = l.left.far - -l.lane;
        expect(spareLeft).toBeCloseTo(spareRight, 10);
        expect(spareLeft).toBeCloseTo(l.M / 6 - l.reach, 10);
        expect(spareLeft).toBeGreaterThan(0);
      });
    }

    it(`keeps the second reading clear of the neighbouring column, and clearer than the centring did (${name})`, () => {
      // Worst case, which is both characters boxed: each box steps its own
      // annotation toward the other. M/3 - the two reaches, where the
      // centring in the lane left M/4 - the two — so the change hands the
      // boundary the same M/12 it hands back to the character.
      for (const reach of REACH) {
        for (const neighbour of REACH) {
          const l = laneAt(size, reach);
          const nr = lengthOf(neighbour, { vars: { "--type-max-size": size } });
          const clearance = l.left.far - neighbourReading(l, nr);
          expect(clearance).toBeCloseTo(l.M / 3 - l.reach - nr, 10);
          expect(clearance).toBeGreaterThan(0);
          // What the rule this replaced came to, at the same two boxes: -1px
          // at the shipped scale, which is the two runs overlapping.
          expect(clearance - (l.M / 4 - l.reach - nr)).toBeCloseTo(l.M / 12, 10);
        }
      }
    });

    it(`keeps the second reading out of the corner the kaeriten and the 踊り字 hold (${name})`, () => {
      // Rule 6 put the mark below the character at `left: 0`, and the 踊り字
      // is below-right at `right: 0`. Both are boxes that grow from an edge
      // of the character *into* it, so both are at x >= 0; the whole of this
      // run is at x < 0, at every length it can take. There is no collision
      // left for a clamp to avoid.
      for (const kana of RUN_LENGTHS) {
        for (const reach of REACH) {
          const l = laneAt(size, reach, kana);
          expect(l.left.near).toBeLessThanOrEqual(0);
        }
      }
    });
  }
});

describe("the second reading, down the column", () => {
  it("has four lengths and no others", () => {
    // ず, べし and ざる, んとす, がごとし. Read off the table and the negation
    // paradigm rather than written down here, so a new 再読文字 or a new
    // inflected answer arrives in this file as a failure rather than silently.
    expect(RUN_LENGTHS).toEqual([1, 2, 3, 4]);
  });

  for (const { name, size } of SCALES) {
    it(`sets the last kana on the character's foot at every one of them (${name})`, () => {
      // Bottom-aligned, which is where a 訓点本 writes it (左下) and what the
      // okurigana on the other side already does — this run is set in the
      // okurigana's colour, in its katakana, and follows its switch, so its
      // foot is the one fixed point on the character whatever the second
      // reading spells.
      for (const kana of RUN_LENGTHS) {
        const l = laneAt(size, "0px", kana);
        expect(l.run.bottom).toBeCloseTo(l.M, 10);
      }
    });

    it(`fills the character from the foot up, and only がごとし passes its top (${name})`, () => {
      const extent = new Map(RUN_LENGTHS.map((kana) => [kana, laneAt(size, "0px", kana)]));
      const M = extent.get(1)!.M;
      // ず the lower third, べし/ざる the lower two thirds, んとす the
      // character exactly — f is M/3, so the four cases are thirds.
      expect(extent.get(1)!.run.top).toBeCloseTo((2 * M) / 3, 10);
      expect(extent.get(2)!.run.top).toBeCloseTo(M / 3, 10);
      expect(extent.get(3)!.run.top).toBeCloseTo(0, 10);
      expect(extent.get(4)!.run.top).toBeCloseTo(-M / 3, 10);
    });

    it(`spills upward into the gap rule 1 leaves, not downward past the foot (${name})`, () => {
      // The one length that does not fit. It goes up, where the gap is a
      // whole character and the lane is empty — the character above's own
      // second reading, if it has one, ends at its own foot, a full gap and
      // a full character higher. A `max(0px, …)` clamp here would push the
      // same overflow the other way, down past the foot and alongside the
      // kaeriten, and would give up the foot as a fixed point.
      const gap = lengthOf("var(--kanji-gap)", { vars: { "--type-max-size": size } });
      for (const kana of RUN_LENGTHS) {
        const l = laneAt(size, "0px", kana);
        expect(l.run.bottom).toBeLessThanOrEqual(l.M + 1e-9);
        expect(-l.run.top).toBeLessThan(gap);
      }
      expect(gap).toBeCloseTo(extentOf(size), 10);
    });
  }
});

/** The gap between two characters, which rule 1 makes one character's height —
 * the room the one overlong run has to stand in. */
function extentOf(size: string): number {
  return lengthOf("var(--size-main)", { vars: { "--type-max-size": size } });
}
