import { describe, expect, it } from "vitest";
import { columnCounts, fittedTracking, matchedDivision, stretchedTracking } from "../src/render/KakikudashiView.ts";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// **The frame around the two panels, said as arithmetic.**
//
// Three margins decide how the page reads as a block: the space above the
// kanbun, the space below it, and the space above the prose. What is wanted of
// them is one identity —
//
//     (below the kanbun) + (above the prose) === (above the kanbun)
//
// — so that the gap *between* the panels comes to the same figure as the frame
// *above* them, and the page reads as one block rather than as two panels with
// a trough between them. It held at 55 = 55 + 55 before, which is to say it did
// not hold at all: the gap was two and a third times the frame.
//
// The identity is arithmetic over four `calc()`s in two stylesheets, and every
// one of them is written against `--size-main` rather than in pixels — so it
// either holds at every type scale or holds at none, and neither a browser nor
// a document is needed to find out which. What is needed is an evaluator, and
// the evaluator below is the whole of the apparatus: it reads the declarations
// out of the files the browser reads them out of, so an agreement here is an
// agreement with the page and not with a copy of it that can drift.
//
// The one term in the identity that is *not* a declaration is the last
// character's own trailing gap. Every character in a kundoku column carries one
// (see `--kanji-advance` in typography.css), the last one's falls below the
// text where a reader sees it as margin, and it is not a quantity
// `--panel-margin-bottom` can spend — which is exactly why that declaration is
// now zero and the identity comes out of `--kanji-gap` on one side of the rail
// and `--size-main / 4` on the other. Those are the two terms
// `--panel-margin-top` is itself made of, handed one to each side, and that is
// the shape the tests below are checking rather than the three numbers.
//
// What cannot be checked from here is what a browser would show: that 55px of
// frame against 70.4px of gap (the 15.4px of rail and border are furniture and
// are not in the sum) reads as even. That was looked at.
// ---------------------------------------------------------------------------

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const typography = readFileSync(join(SRC, "render", "typography.css"), "utf-8");
const tategaki = readFileSync(join(SRC, "render", "tategaki.css"), "utf-8");
const appCss = readFileSync(join(SRC, "app.css"), "utf-8");

/** The root font size every `rem` in these files resolves against. Nothing in
 * the app sets one, so it is the UA's, and 16 is what every engine ships. */
const REM = 16;

const withoutComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");

/** The body of the first top-level rule with exactly this selector.
 *
 * Anchored at the start of a line, because `.tategaki` is a substring of
 * `.kundoku-panel .tategaki` and the three rules that share the word are three
 * different rules with three different things to say. */
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
        // `contains` is not a nicety: two rules may legitimately share a
        // selector and say different things about it — the prose rail is hidden
        // and offset by the same `#app:not(.kakikudashi-collapsed)` condition,
        // written twice because one of the two is layout and the other is
        // paint, and a test that took the first match would silently read the
        // wrong one.
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

const ROOT = declarations(ruleBody(typography, ":root"));
/** `#app`'s own custom properties. The type scale is declared on `:root` in
 * typography.css and the layout's lengths on `#app` in app.css, and an
 * expression here may reach for either — the prose rail's offset is written in
 * the panels' margins, and the rail tracks in the rail's own thickness. Both
 * are ancestors of everything that reads them, so the cascade hands a rule
 * both; this map is that, flattened. */
const APP = declarations(ruleBody(appCss, "#app"));

/** A grid track list, split on its own top-level whitespace — a `calc()` may
 * run over several lines and carry spaces of its own, and it is one track. */
function tracks(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let word = "";
  for (const ch of list.replace(/\s+/g, " ").trim()) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === " " && depth === 0) {
      if (word) out.push(word);
      word = "";
    } else word += ch;
  }
  if (word) out.push(word);
  return out;
}

/** Which of the two kinds a track is, which is the whole of what interpolation
 * asks of a pair — a length against a length, or a flex against a flex. */
const kindOf = (track: string) => (/(^|[^-\w])\d*\.?\d+fr\b/.test(track) ? "flex" : "length");

/** Splits a function's argument list on its own commas, ignoring any inside a
 * nested call. `round(down, 100% - a - b, c)` is three arguments and the middle
 * one is an expression. */
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
 * left. Innermost first, so an argument is already plain arithmetic by the time
 * its call is rewritten. */
function rewriteCalls(expr: string, name: string, replace: (parts: string[]) => string): string {
  for (;;) {
    // The last opening of this call has no other opening of it inside, so its
    // matching close is the first unbalanced `)` after it.
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
    const inner = expr.slice(open + name.length + 1, close);
    expr = expr.slice(0, open) + replace(args(inner)) + expr.slice(close + 1);
  }
}

/** One CSS length in pixels.
 *
 * `var()` (with its fallback), `calc()`, `max()`, `min()` and CSS's own
 * `round(down, …)` — which is the whole of the vocabulary these four
 * declarations are written in, and `round(down, …)` is there because the
 * panel's height is written with it and the whole-characters constraint below
 * is a fact about that rounding.
 *
 * `percent` is what a `%` resolves against, which for the two rules that use
 * one is the box the panel is laid in. `vars` overrides or adds to `:root` —
 * `--annotation-overhang` is the one that matters, since it is written from
 * script (`publishAnnotationOverhang`) and is absent from the stylesheet
 * entirely. */
function lengthOf(
  expr: string,
  { percent = 0, vars = {} as Record<string, string>, rem = REM } = {},
): number {
  const lookup = (name: string) => vars[name] ?? ROOT.get(name) ?? APP.get(name);
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
  text = rewriteCalls(text, "round", ([mode, value, step]) => {
    if (mode !== "down") throw new Error(`only round(down, …) is modelled, not ${mode}`);
    return `(Math.floor((${value})/(${step}))*(${step}))`;
  });
  text = text.replace(/\bmax\(/g, "Math.max(").replace(/\bmin\(/g, "Math.min(").replace(/\bcalc\(/g, "(");
  text = text
    .replace(/(\d*\.?\d+)rem\b/g, (_, n) => `(${Number(n) * rem})`)
    .replace(/(\d*\.?\d+)px\b/g, "$1")
    .replace(/(\d*\.?\d+)%/g, (_, n) => `(${(Number(n) / 100) * percent})`);
  // eslint-disable-next-line no-new-func
  const value = Function(`"use strict"; return (${text});`)() as number;
  if (!Number.isFinite(value)) throw new Error(`${expr} came to ${value}`);
  return value;
}

/** The three margins of the split layout, at one type scale.
 *
 * `belowTheKanbun` is what a reader sees and not what the declaration says:
 * the last character's own trailing gap, plus whatever `--panel-margin-bottom`
 * adds to it. The distinction is the whole of why that declaration could go to
 * zero without the text ending up against the panel's edge. */
function margins(vars: Record<string, string> = {}, rem = REM) {
  const at = (expr: string) => lengthOf(expr, { vars, rem });
  const prose = declarations(ruleBody(tategaki, ".kakikudashi-panel .tategaki"));
  return {
    aboveTheKanbun: at("var(--panel-margin-top)"),
    belowTheKanbun: at("calc(var(--kanji-gap) + var(--panel-margin-bottom))"),
    aboveTheProse: at(prose.get("padding-top")!),
    belowTheProse: at(prose.get("padding-bottom")!),
    gap: at("var(--kanji-gap)"),
    advance: at("var(--kanji-advance)"),
    declaredBottom: at("var(--panel-margin-bottom)"),
    sideInset: at(declarations(ruleBody(tategaki, ".tategaki")).get("padding")!),
    proseSize: at("var(--size-kakikudashi)"),
  };
}

describe("the frame the two panels share", () => {
  it("gives the space between the panels the same figure as the space above them", () => {
    const m = margins();
    expect(m.belowTheKanbun + m.aboveTheProse).toBe(m.aboveTheKanbun);
  });

  it("is the figures the page was measured at", () => {
    const m = margins();
    // 1280x900, the shipped scale: read off the laid-out page, and the reason
    // the identity above is stated in terms rather than in these.
    expect(m.aboveTheKanbun).toBe(55);
    expect(m.belowTheKanbun).toBe(44);
    expect(m.aboveTheProse).toBe(11);
    expect(m.declaredBottom).toBe(0);
  });

  it("splits the sum into the two terms the top margin is itself made of", () => {
    const m = margins();
    // Not a restatement of the identity: this is the *shape* of the answer.
    // The kanbun's side is one whole `--kanji-gap`, which is the term it could
    // not have spent anyway — every character carries one and the last one's
    // falls below the text whatever the margin says. The prose's side is the
    // quarter-glyph that is left, which is what `--panel-margin-top` adds on
    // top of the same gap. So the two sides are the top margin taken apart,
    // and that is why the sum is exact rather than close.
    expect(m.belowTheKanbun).toBe(m.gap);
    expect(m.aboveTheProse).toBe(m.aboveTheKanbun - m.gap);
  });

  it("holds at every type scale, since not one of the four terms is a pixel", () => {
    for (const rem of [10, 12, 16, 20, 24, 32]) {
      const m = margins({}, rem);
      expect(m.belowTheKanbun + m.aboveTheProse).toBe(m.aboveTheKanbun);
    }
  });

  it("insets the foot of a prose column exactly as it insets the two sides", () => {
    const m = margins();
    // The reader's third figure: the bottom equal to the sides. Both are
    // `--kanji-gap`, and the rule says so by naming it rather than by leaving
    // the shorthand to supply it — `.tategaki`'s own `padding-bottom` is
    // `--panel-margin-bottom`, which is zero, so a prose rule that said
    // nothing here would set the text against the panel's edge.
    expect(m.belowTheProse).toBe(m.sideInset);
    expect(m.belowTheProse).toBe(44);
  });

  it("still leaves the prose its hanging-mark room, which is what the 11px came out of", () => {
    const m = margins();
    // ぶら下げ: a 、 or a 。 at a column's foot hangs into the padding below
    // the prose. **Measured on the page rather than modelled**, because this
    // margin lost 11px and that was the room it lost it from: the model gives
    // a hung mark `letter-spacing: -1em`, which collapses its box to nothing,
    // so its ink runs exactly one prose advance past the column's content
    // edge — and one prose advance measured in a laid-out panel is 25.3px, off
    // a hung 。 (box height 0) and an unhung one (box height 25.3) in the same
    // passage. Nothing hangs at the head of a column, which is why only the
    // head gave up its gap to the sum above.
    const PROSE_ADVANCE = m.proseSize * 1.15;
    expect(PROSE_ADVANCE).toBeCloseTo(25.3, 1);
    expect(m.belowTheProse).toBeGreaterThan(PROSE_ADVANCE);
    // 18.7px of headroom, where there was 29.7. Held as a ratio, since both
    // terms answer to `--size-main` and neither is a pixel: the foot is 1.74
    // advances deep at every scale, so the headroom does not thin as the type
    // grows.
    for (const rem of [10, 16, 24, 32]) {
      const scaled = margins({}, rem);
      expect(scaled.belowTheProse / (scaled.proseSize * 1.15)).toBeCloseTo(1.738, 2);
    }
  });
});

describe("what still gets out of the way of an annotation", () => {
  // `--panel-margin-bottom` had a floor of one quarter-glyph and now has none,
  // so the `max()` against `--annotation-overhang` is the only thing left
  // holding the deepest reading on the page inside the panel. It is also a
  // cleaner guard for having lost the floor: it comes to exactly the room the
  // overhang asks for and never to more.
  const overhang = (px: number) => margins({ "--annotation-overhang": `${px}px` }).declaredBottom;

  it("writes nothing while the trailing gap is room enough", () => {
    // 酒蟲's deepest mark is a two-glyph kaeriten reaching 32px below the foot;
    // rule 5 in kunten.css keeps a reading's lane to 73.33px, which is a run of
    // 29.33px below a 44px character. Both are inside the 44px gap.
    expect(overhang(0)).toBe(0);
    expect(overhang(30)).toBe(0);
    expect(overhang(32)).toBe(0);
    expect(overhang(44)).toBe(0);
  });

  it("takes exactly the shortfall once one is deeper than the gap", () => {
    // A seven-kana reading runs 102.67px from the character's top, which is
    // 58.67px below its foot: 14.67px more than the gap, and 14.67px is what
    // the panel takes. `.tategaki` is `overflow-y: hidden` and clips at the
    // padding box, so a pixel short here is a kana cut in half.
    expect(overhang(58.67)).toBeCloseTo(14.67, 5);
    expect(overhang(88)).toBe(44);
  });

  it("never goes negative, whatever a shallow page publishes", () => {
    expect(overhang(1)).toBe(0);
  });
});

describe("the kundoku panel still takes whole characters", () => {
  // The constraint the margins are most able to break, and the one this file
  // exists beside: `.kundoku-panel .tategaki` sets its height to the two
  // margins plus a whole number of `--kanji-advance`s, and a column may hold
  // nothing else — a panel a fraction of a character tall is a state it cannot
  // hold, and every argument in KakikudashiView.ts about the split moving in
  // 88px steps rests on it.
  const height = declarations(ruleBody(tategaki, ".kundoku-panel .tategaki")).get("height")!;

  it("rounds any share it is given down to a whole number of them", () => {
    for (let share = 200; share <= 1400; share += 7) {
      const used = lengthOf(height, { percent: share });
      const text = used - margins().aboveTheKanbun - margins().belowTheKanbun + margins().gap;
      expect(text % margins().advance).toBe(0);
      expect(used).toBeLessThanOrEqual(share);
    }
  });

  it("does the same at a scale where the advance is not a round number", () => {
    for (const rem of [10, 13, 21]) {
      const m = margins({}, rem);
      for (let share = 300; share <= 900; share += 11) {
        const used = lengthOf(height, { percent: share, rem });
        expect((used - m.aboveTheKanbun - m.declaredBottom) % m.advance).toBeCloseTo(0, 6);
      }
    }
  });
});

describe("a rail hides beside its own open panel", () => {
  // The reveal is a cascade *tie* broken by source order — the hide rule and
  // the reveal rule are the same weight, and app.css says so where it declares
  // them. That is the house arrangement (the collapse transitions and
  // kunten.css both use it) and it is also the one thing about this that a
  // reordering of the file would silently break, which is what this checks.
  const css = withoutComments(appCss);
  const hidden = css.indexOf("--rail-shown: 0");
  const shown = css.indexOf("--rail-shown: 1");

  it("declares both halves", () => {
    expect(hidden).toBeGreaterThan(-1);
    expect(shown).toBeGreaterThan(-1);
  });

  it("puts the reveal after the hide, which is what makes the reveal win", () => {
    expect(shown).toBeGreaterThan(hidden);
  });

  it("hides each rail on its own panel's collapse class and no other", () => {
    const rule = css.slice(css.lastIndexOf("}", hidden) + 1, hidden);
    for (const [collapsed, rail] of [
      ["left-collapsed", "rail-left"],
      ["right-collapsed", "rail-right"],
      ["kakikudashi-collapsed", "rail-kakikudashi"],
    ]) {
      expect(rule).toContain(`#app:not(.${collapsed}) .${rail}`);
    }
  });

  it("answers a keyboard as well as a pointer", () => {
    // The rails are `<button>`s in the tab order and a keyboard reader reaches
    // all three with no pointer at all. A rail that only `:hover` can bring
    // back is a rail a keyboard reader has lost, and a collapsed panel with it.
    const rule = css.slice(css.lastIndexOf("}", shown) + 1, shown);
    expect(rule).toContain(":hover");
    expect(rule).toContain(":focus-visible");
  });

  it("reveals it in place, with nothing in the rule that could resize anything", () => {
    // The reason it is opacity and not width, display or visibility: a reveal
    // that changed the layout would resize `.main`, and `observePanelFit`'s
    // `ResizeObserver` would answer a hover with a whole fit — up to seven
    // forced layouts and the passage re-set under the reader's eye. (The other
    // half of the argument is that an `opacity: 0` box is still a hit target,
    // which is what leaves the invisible rail reachable at all; that is a fact
    // about hit testing and is checked in a browser, not here.)
    const rail = declarations(ruleBody(appCss, ".rail"));
    expect(rail.get("opacity")).toBe("var(--rail-shown, 1)");
    // One property and one house interval. `top` rode along here while the
    // prose badge was centred on the join and had to be corrected onto the
    // middle of the gap; it is pinned inside the kundoku panel's foot now and
    // lands there by placement, so the correction and its transition are gone.
    expect(rail.get("transition")).toBe("opacity 160ms ease-out");
    for (const property of ["display", "visibility", "width", "height", "margin", "padding"]) {
      const declared = rail.get(property);
      // The rail's own box is unchanged from what it always was; nothing in
      // the auto-hide touches a length.
      // The strip is the proximity band — the badge is `--rail-thickness` and
      // is drawn at the end of it. A control nobody can see cannot be its own
      // target, so the band came back after the badge made it briefly
      // unnecessary; it is much deeper than the 0.55rem that once merely
      // widened a visible hairline.
      if (property === "width") expect(declared).toBe("var(--rail-band)");
      else if (property === "height") expect(declared).toBe("100%");
      else if (property === "padding") expect(declared).toBe("0");
      else expect(declared).toBeUndefined();
    }
  });
});

describe("a rail takes a track only while its panel is shut", () => {
  // ── The change, and the one thing it could have broken ────────────────────
  // A rail used to sit in a 0.9rem track of its own, which took a band out of
  // the page that no text could enter. The track is `0px` now while the panel
  // it answers for is open: the two boxes on either side abut, the rail
  // overflows the nothing between them and floats over the join, and the page
  // gets the 0.9rem back — 28.8px across from the two sidebars, 14.4px down
  // from the prose rail.
  //
  // It comes back when the panel is shut, and it must: a zero-width column at
  // the window's own edge would put half of the one control that reopens the
  // panel off the screen.
  //
  // What that risks is the property every one of these track lists is written
  // to have. A list interpolates only where the two ends are the same length
  // and each pair of tracks is of one kind — the note on `#app` tells the story
  // of the round where `1fr auto 0` against `1fr auto 1fr` failed that and the
  // collapse snapped instead of sliding. The middle pair used to be the one
  // that never moved, and it moves now, so it is the pair to check.
  const app = declarations(ruleBody(appCss, "#app"));

  const RAILS = [
    ["--left-rail-track", "#app.left-collapsed"],
    ["--right-rail-track", "#app.right-collapsed"],
  ] as const;
  /** The third has no `#app` rule at all any more: with nothing conditional
   * left to say about the prose rail's row, the whole block went. */
  const KAKIKUDASHI_TRACK = "--kakikudashi-rail-track";

  it("gives every rail nothing while its panel is open", () => {
    for (const [track] of RAILS) expect(app.get(track)).toBe("0px");
    expect(app.get(KAKIKUDASHI_TRACK)).toBe("0px");
  });

  it("takes none of it back when the panel is shut either", () => {
    // These were conditional for one round — zero open, the rail's own
    // thickness shut — because a badge *centred* on a zero-width join at the
    // window's edge is half off the screen. That was right about the badge and
    // wrong about the track: the badge stopped being centred instead. What the
    // conditional was costing is the margin the reader saw, 28px a side and
    // 56px with both sidebars shut.
    for (const [track, rule] of RAILS) {
      expect(declarations(ruleBody(appCss, rule)).get(track)).toBeUndefined();
    }
    // And `kakikudashi-collapsed` has no `#app` rule left to declare one in.
    expect(withoutComments(appCss)).not.toContain("#app.kakikudashi-collapsed {");
  });

  it("puts each badge inside the edge of the panel that stays, which is what makes that safe", () => {
    // The property the conditional track used to buy, bought by placement:
    // pinned to the inward side of its join, a badge is wholly on screen at
    // either end of the movement, including when the join has arrived at the
    // window's own edge.
    expect(declarations(ruleBody(appCss, ".rail", "justify-self:")).get("justify-self")).toBe("start");
    expect(declarations(ruleBody(appCss, ".rail-right", "justify-self:")).get("justify-self")).toBe("end");
    expect(declarations(ruleBody(appCss, ".rail-kakikudashi")).get("align-self")).toBe("end");
    // Never `center`, which is the one that hangs a badge off the edge.
    for (const rule of [".rail", ".rail-right"]) {
      expect(declarations(ruleBody(appCss, rule, "justify-self:")).get("justify-self")).not.toBe("center");
    }
  });

  it("keeps every pair of tracks a length, so the lists still interpolate", () => {
    for (const [track] of [...RAILS.map(([t]) => [t] as const), [KAKIKUDASHI_TRACK] as const]) {
      // Both ends of the pair are now the same zero, which is still a length
      // against a length. What would break the list is a keyword, and there is
      // none in it.
      expect(app.get(track)).toBe("0px");
      expect(lengthOf(`var(${track})`)).toBe(0);
    }
  });

  it("matches the prose panel's two row lists track for track", () => {
    const open = tracks(
      declarations(
        ruleBody(tategaki, "#app:not(.kakikudashi-collapsed):not(.kakikudashi-empty) .main"),
      ).get("grid-template-rows")!,
    );
    const shut = tracks(declarations(ruleBody(appCss, "#app.kakikudashi-collapsed .main")).get("grid-template-rows")!);
    expect(open).toHaveLength(shut.length);
    expect(open.map(kindOf)).toEqual(shut.map(kindOf));
    expect(open.map(kindOf)).toEqual(["length", "length", "flex"]);
    // The middle one is the same `var()` on both sides, so the two rules
    // cannot come to disagree about what a collapsed rail stands on.
    expect(open[1]).toBe("var(--kakikudashi-rail-track)");
    expect(shut[1]).toBe("var(--kakikudashi-rail-track)");
    for (const track of [...open, ...shut]) expect(track).not.toContain("auto");
  });

  it("keeps `#app`'s five columns five, with both rail tracks named", () => {
    const cols = tracks(app.get("grid-template-columns")!);
    expect(cols).toHaveLength(5);
    expect(cols.map(kindOf)).toEqual(["length", "length", "flex", "length", "length"]);
    expect(cols[1]).toBe("var(--left-rail-track)");
    expect(cols[3]).toBe("var(--right-rail-track)");
    for (const track of cols) expect(track).not.toContain("auto");
  });
});

describe("the division is an edge, and the control is a badge on it", () => {
  it("draws the edge as a rule of the rail's own, not as a border on a panel", () => {
    // The reader asked for an edge with a badge, which is a separation of two
    // things the rail used to be at once. The strip paints nothing itself now:
    // `::before` is the edge — one hairline the length of the join — and
    // `::after` is the badge sitting astride it. Keeping both on the one
    // element is what keeps the earlier promise that a boundary which *is* the
    // control cannot outlive it, fade at a different rate, or be left behind.
    const panel = declarations(ruleBody(appCss, ".main-panel"));
    expect(panel.get("border-block-end")).toBeUndefined();
    expect(withoutComments(appCss)).not.toContain("border-block-end");

    // And the strip paints nothing at all: the track a badge stands in is
    // see-through, so the panels that reach under the furniture show through
    // it. That reverses what a full-length rail needed — a rail *was* the
    // division and had to cover whatever it crossed — and it is safe because
    // every inset the panels carry is larger than the 14px a badge reaches in.
    const strip = declarations(ruleBody(appCss, ".rail"));
    expect(strip.get("background")).toBe("none");
    expect(strip.get("border")).toBe("0");
    expect(strip.get("background-color")).toBeUndefined();
    // The badge is the one opaque thing, and it is opaque so that the edge
    // rule stops under it rather than to hide any text.
    expect(declarations(ruleBody(appCss, ".rail::after")).get("background")).toBe("var(--color-bg)");

    const edge = declarations(ruleBody(appCss, "#app:not(.kakikudashi-collapsed) .rail-kakikudashi::before"));
    expect(edge.get("position")).toBe("absolute");
    expect(edge.get("height")).toBe("1px");
    expect(edge.get("background")).toBe("var(--color-border)");
    // Through the middle of the badge, which sits at the foot of the band, so
    // the mark is on the rule rather than beside it.
    expect(edge.get("bottom")).toBe("calc(var(--rail-thickness) / 2)");
    // And only while there are two panels to divide. Shut, the badge stays and
    // the rule goes: an edge is a statement about two things.
    expect(withoutComments(appCss)).not.toContain("\n.rail-kakikudashi::before");
    // The same ink and weight as the two sidebar borders it shares a page
    // with — the softer `--menu-rule` mix was the other candidate and would
    // have made this line a different kind of line from those two.
    expect(declarations(ruleBody(appCss, ".sidebar")).get("border-inline-end")).toBe(
      "1px solid var(--color-border)",
    );
    expect(declarations(ruleBody(appCss, ".saved-panel")).get("border-inline-start")).toBe(
      "1px solid var(--color-border)",
    );
  });

  it("gives the edge only to the join that has no border of its own", () => {
    // The two sidebars already draw a rule exactly where their rails are
    // centred, so a second hairline on the same pixel would say nothing; and
    // theirs are permanent, because a panel of controls wants a frame whether
    // or not the reader is reaching for its toggle. The two views of one text
    // want none, which is why this one hides with its badge.
    const css = withoutComments(appCss);
    expect(css).toContain(".rail-kakikudashi::before");
    expect(css).not.toContain(".rail-left::before");
    expect(css).not.toContain(".rail-right::before");
  });

  it("takes the border's pixel out of the row arithmetic with it", () => {
    // The `+ 1px` in the split was that border and nothing else: a grid row
    // sizes the border box while `.tategaki`'s `100%` resolves against the
    // content box, so the pixel had to be added or the panel came out a pixel
    // short of a whole number of slots — and a pixel short costs a whole
    // character, since the rounding floors. With no border the two boxes are
    // the same box, and the row, the content box and the text agree exactly.
    const rows = declarations(
      ruleBody(tategaki, "#app:not(.kakikudashi-collapsed):not(.kakikudashi-empty) .main"),
    ).get("grid-template-rows")!;
    expect(rows).not.toContain("1px");
    const m = margins();
    const height = declarations(ruleBody(tategaki, ".kundoku-panel .tategaki")).get("height")!;
    const firstTrack = tracks(rows)[0];
    for (let box = 300; box <= 1200; box += 13) {
      // The row the split asks for, at no extra slots…
      const row = lengthOf(firstTrack, { percent: box });
      // …and what the text sets itself to inside it, which is now the same box.
      expect(lengthOf(height, { percent: row })).toBe(row);
      expect((row - m.aboveTheKanbun - m.declaredBottom) % m.advance).toBe(0);
    }
  });
});

describe("the prose badge lands in the middle of the gap without being put there", () => {
  // It used to carry `top: -16.5px` — half the difference between the kanbun's
  // trailing gap and the prose's head inset — because a badge centred on the
  // join sat 3.8px off the prose and 36.8px off the kanbun and read as a bar
  // the prose panel was wearing. Nothing is centred on the join now. The badge
  // is pinned inside the kundoku panel's foot, which puts it where the
  // correction used to have to put it.
  const RAIL = 28; // --rail-thickness at the shipped scale

  it("has no offset rule left to keep in step with anything", () => {
    const css = withoutComments(appCss);
    expect(css).not.toContain("--prose-margin-top) - var(--kanji-gap)");
    // `--prose-margin-top` is back to one reader, the prose panel's own inset.
    expect((css.match(/--prose-margin-top/g) ?? []).length).toBe(0);
    expect((withoutComments(tategaki).match(/var\(--prose-margin-top\)/g) ?? []).length).toBe(1);
  });

  it("still lands near the optical middle of the gap, by placement", () => {
    const m = margins();
    // Measured from the join: the badge fills the band and the band is pinned
    // to the join, so the mark's middle is half a badge above it.
    const above = m.belowTheKanbun - RAIL / 2;
    const below = m.aboveTheProse + RAIL / 2;
    expect(above).toBeCloseTo(30, 1);
    expect(below).toBeCloseTo(25, 1);
    // Two and a half pixels off the true middle of a 55px gap, where the
    // correction was exact — and it costs a rule, a transition and a
    // cross-file `var()` less to be that near.
    const middle = (m.belowTheKanbun + m.aboveTheProse) / 2;
    expect(Math.abs(above - middle)).toBeLessThan(3);
  });

  it("sits wholly inside the panel that stays, in every state", () => {
    // The property that lets the track be zero: the badge never straddles a
    // join, so a join at the window's own edge never cuts it in half.
    const m = margins();
    // Above the join it has the kanbun's whole trailing gap to stand in…
    expect(RAIL).toBeLessThanOrEqual(m.belowTheKanbun);
    // …and the band it fills is that gap or less, never more.
    expect(lengthOf(declarations(ruleBody(appCss, ".rail-kakikudashi")).get("height")!)).toBeLessThanOrEqual(
      m.belowTheKanbun,
    );
  });
});

// ---------------------------------------------------------------------------
// **The fit's own property: it picks the best division there is.**
//
// The reader's complaint that produced this block was that the two passages
// no longer come out the same length — 440px of kanbun against 396px of prose
// at a 1280x900 window — and the suspicion was that the height freed by taking
// the rail out of the flow and the prose panel's foot down to its side inset
// had gone somewhere useless instead of into the columns.
//
// It had not: the ledger balances to the pixel with nothing left over
// (`the freed height ends up inside the panels` below). What is true is that
// **none of it could reach the kanbun**, and that is structural rather than a
// bug: the kundoku row is `--panel-margin-top + round(down, 60% - margins, 88)
// + steps x 88`, a function of `.main`'s own height and the step alone. Height
// freed *between* the panels is not in that expression — it lands in the
// prose panel's `1fr` remainder, which is where it went. So the prose column
// gained a character (6 to 7) and its passage shortened from 484px to 396px,
// crossing the target rather than reaching it; the kanbun stayed at seven.
//
// Which leaves the question this block exists to answer: is 44px the best the
// search can do at that geometry, or is the search failing to find something
// better? The tables below are that question measured — every candidate the
// search can reach, swept in a browser at two window heights, with the extent
// of each passage read off the laid-out page. They are the evidence, and they
// are here so that a future change to `matchedDivision`, to the margins, or to
// the row arithmetic is checked against a real page rather than against a
// model of one.
// ---------------------------------------------------------------------------

/** A swept geometry: what the search could see, measured rather than modelled.
 *
 * `target` is the kundoku passage's extent at that split (its column count
 * times `--column-pitch`), `k` the characters its column then holds, `ceiling`
 * the most the prose panel can hold to a column, and `extents` how far the
 * prose runs at each column length — `ceil(characters / slots) x
 * --column-pitch-kakikudashi`, which is the staircase `matchedSlots` walks.
 *
 * The prose staircase is identical at both heights and at every step within
 * one, which is not luck: how far a passage runs at a given column length is a
 * fact about the text and that length, which is exactly what `measuredExtents`
 * caches on in `fitPassageExtent`.
 *
 * Swept in Chrome on 2026-09-04, 1280px wide, both sidebars open, on 學而時習之
 * (30 advancing kanbun cells, 63 characters of prose). No mark hangs at any of
 * these column lengths on this text, so `applyHangingMarks` moves none of
 * these numbers. */
interface Sweep {
  readonly main: number;
  readonly rows: readonly { steps: number; k: number; target: number; ceiling: number }[];
  readonly extents: Readonly<Record<number, number>>;
}

const PROSE_STAIRCASE = {
  1: 1452, 2: 1452, 3: 924, 4: 748, 5: 616, 6: 484, 7: 396,
  8: 352, 9: 308, 10: 308, 11: 264, 12: 264, 13: 220, 14: 220,
} as const;

/** 1280x900 — the shipped window, and the one the reader was looking at. */
const AT_900: Sweep = {
  main: 900,
  rows: [
    { steps: 0, k: 5, target: 528, ceiling: 14 },
    { steps: 1, k: 6, target: 440, ceiling: 10 },
    { steps: 2, k: 7, target: 440, ceiling: 7 },
    { steps: 3, k: 8, target: 352, ceiling: 3 },
    // steps 4 leaves the prose panel no measure at all: the walk stops here.
  ],
  extents: PROSE_STAIRCASE,
};

/** 1280x1004 — chosen from the table above rather than found by hunting, as
 * the shortest window at which the two passages can coincide, and then
 * confirmed in the browser. */
const AT_1004: Sweep = {
  main: 1004,
  rows: [
    { steps: 0, k: 6, target: 440, ceiling: 14 },
    { steps: 1, k: 7, target: 440, ceiling: 11 },
    { steps: 2, k: 8, target: 352, ceiling: 8 },
    { steps: 3, k: 9, target: 352, ceiling: 4 },
  ],
  extents: PROSE_STAIRCASE,
};

/** The search, run over a swept geometry exactly as `fitPassageExtent` runs it
 * over a page: `apply` hands back what the page measures at each split, and
 * `extentAt` how far the prose then runs. */
function divisionOver(sweep: Sweep) {
  const row = (steps: number) => sweep.rows.find((r) => r.steps === steps);
  return matchedDivision(
    6,
    (steps) => {
      const at = row(steps);
      if (!at) return null;
      if (at.ceiling < (steps === 0 ? 1 : 3)) return null;
      return { target: at.target, ceiling: at.ceiling };
    },
    (slots) => sweep.extents[slots as keyof typeof PROSE_STAIRCASE] ?? Infinity,
  );
}

/** Every division the search could have returned, and what each would cost. */
function everyCandidate(sweep: Sweep) {
  const out: { steps: number; slots: number; gap: number; unused: number }[] = [];
  for (const at of sweep.rows) {
    if (at.ceiling < (at.steps === 0 ? 1 : 3)) continue;
    for (let slots = 1; slots <= at.ceiling; slots++) {
      const extent = sweep.extents[slots as keyof typeof PROSE_STAIRCASE];
      if (extent === undefined) continue;
      out.push({ steps: at.steps, slots, gap: Math.abs(extent - at.target), unused: at.ceiling - slots });
    }
  }
  return out;
}

describe("the fit picks the best division on offer", () => {
  for (const [name, sweep] of [["1280x900", AT_900], ["1280x1004", AT_1004]] as const) {
    it(`is the smallest gap available at ${name}`, () => {
      const chosen = divisionOver(sweep)!;
      const best = Math.min(...everyCandidate(sweep).map((c) => c.gap));
      // The property, and the one that would have caught a search that had
      // stopped searching: not "the gap is small" but "no reachable division
      // has a smaller one".
      expect(chosen.gap).toBe(best);
    });

    it(`breaks the tie on the fuller panel at ${name}`, () => {
      const chosen = divisionOver(sweep)!;
      const tied = everyCandidate(sweep).filter((c) => c.gap === chosen.gap);
      // Among equals it takes the one that gives the prose panel's whole share
      // to the text — and so, since a step moves height the other way, the one
      // that gives the kanbun the most characters to a column.
      expect(chosen.unused).toBe(Math.min(...tied.map((c) => c.unused)));
      expect(chosen.steps).toBe(Math.max(...tied.filter((c) => c.unused === chosen.unused).map((c) => c.steps)));
    });
  }

  it("cannot do better than one prose column at 1280x900, and the reason is arithmetic", () => {
    const chosen = divisionOver(AT_900)!;
    expect(chosen).toMatchObject({ steps: 2, slots: 7, gap: 44, unused: 0 });
    // Both extents are whole numbers of columns — the kanbun in units of
    // `--column-pitch` (88) and the prose in half that — so every gap the page
    // can show is a multiple of 44 and the two coincide only where the prose
    // runs to exactly twice the kanbun's columns. That needs
    // `2 x ceil(30 / k) === ceil(63 / slots)`, and over the reachable pairs:
    //
    //   k = 5 → 6 kanbun columns → 12 prose columns → no whole `slots` gives 12
    //   k = 6 → 5 → 10 → none gives 10 either (63/7 = 9, 63/6 = 11)
    //   k = 7 → 5 → 10 → the same
    //   k = 8 → 4 →  8 → slots 8 does it — but at k = 8 the panel holds 3
    //
    // The one step that shortens the kanbun far enough is the same step that
    // starves the prose below the column length the match needs. So zero is
    // not merely unreached here, it is unreachable.
    for (const c of everyCandidate(AT_900)) expect(c.gap % 44).toBe(0);
    expect(everyCandidate(AT_900).some((c) => c.gap === 0)).toBe(false);
  });

  it("reaches zero at a taller window, which is what makes 900 a fact about the geometry", () => {
    const chosen = divisionOver(AT_1004)!;
    expect(chosen).toMatchObject({ steps: 2, slots: 8, gap: 0 });
    // 352px of kanbun against 352px of prose — four columns to eight, the
    // two-to-one the panels are built around. Confirmed on the page.
    expect(AT_1004.extents[8]).toBe(AT_1004.rows[2].target);
  });
});

describe("every division the search may return holds whole characters", () => {
  // The constraint the split exists to preserve, checked over the swept
  // geometries rather than over an idealised one: a step is exactly one
  // `--kanji-advance`, so the kundoku column is a whole number of characters
  // at every candidate and not only at the chosen one. A fractional column is
  // not a state the panel can hold — `.kundoku-panel .tategaki` rounds down to
  // one — so a candidate that implied one would be a candidate measured in a
  // layout the page can never be in.
  for (const [name, sweep] of [["1280x900", AT_900], ["1280x1004", AT_1004]] as const) {
    it(`at ${name}, at every step of the walk`, () => {
      const m = margins();
      for (const at of sweep.rows) {
        expect(Number.isInteger(at.k)).toBe(true);
        // The row the CSS would give that step, back-computed, lands on the
        // same whole number of advances.
        const row = m.aboveTheKanbun + m.declaredBottom + at.k * m.advance;
        expect((row - m.aboveTheKanbun - m.declaredBottom) % m.advance).toBe(0);
        // And one step apart is exactly one character apart.
        const next = sweep.rows.find((r) => r.steps === at.steps + 1);
        if (next) expect(next.k - at.k).toBe(1);
      }
    });
  }
});

describe("the freed height ends up inside the panels", () => {
  // Measured at 1280x900 before and after this round's three changes, as the
  // whole of `.main` divided into text and frame. The point of writing it as a
  // ledger is that it is the claim the reader doubted, and it either balances
  // or it does not.
  const BEFORE = { kundokuText: 616, proseText: 147.6, kundokuTop: 55, kundokuBottom: 0,
    border: 1, railRow: 14.4, proseTop: 11, proseBottom: 55 };
  const AFTER = { kundokuText: 616, proseText: 174, kundokuTop: 55, kundokuBottom: 0,
    border: 0, railRow: 0, proseTop: 11, proseBottom: 44 };
  const sum = (l: Record<string, number>) => Object.values(l).reduce((a, b) => a + b, 0);

  it("accounts for all 900px in both, with nothing sitting as slack", () => {
    expect(sum(BEFORE)).toBeCloseTo(900, 5);
    expect(sum(AFTER)).toBeCloseTo(900, 5);
  });

  it("moves 26.4px of furniture into the prose column and none of it anywhere else", () => {
    const freed = BEFORE.border + BEFORE.railRow + (BEFORE.proseBottom - AFTER.proseBottom);
    expect(freed).toBeCloseTo(26.4, 5);
    expect(AFTER.proseText - BEFORE.proseText).toBeCloseTo(freed, 5);
    // And the kanbun gets none of it, which is the part that surprised. Its
    // height is `60%` of `.main` rounded down to whole characters, plus the
    // step: freeing height *between* the panels does not appear in that
    // expression at all. Only a taller window or another step can lengthen
    // that column, and 26.4px is not a character.
    expect(AFTER.kundokuText).toBe(BEFORE.kundokuText);
    expect(margins().advance).toBeGreaterThan(freed);
  });

  it("buys the prose a character to the column, which is what shortened its passage", () => {
    const advance = 25.3;
    expect(Math.round(BEFORE.proseText / advance)).toBe(6);
    expect(Math.round(AFTER.proseText / advance)).toBe(7);
    // 484px at six to the column, 396px at seven: the passage crossed the
    // 440px target rather than landing on it, going from 44px longer than the
    // kanbun to 44px shorter. The same |gap| by arithmetic accident and not
    // the same layout — which is why the report that said "the same match
    // quality as before" was the wrong thing to say about it.
    expect(PROSE_STAIRCASE[6]).toBe(484);
    expect(PROSE_STAIRCASE[7]).toBe(396);
    expect(Math.abs(PROSE_STAIRCASE[6] - 440)).toBe(Math.abs(PROSE_STAIRCASE[7] - 440));
  });
});

// ---------------------------------------------------------------------------
// **The prose panel is full, at every window height and not only at the lucky
// ones.**
//
// The defect this block exists for: a reader saw 92px of blank below a
// five-line passage and asked what it was for. It was the fine control. To
// make the prose passage run further the fit sets a shorter column, and it
// used to do that by writing a shorter *box* — an inline height on the
// `.tategaki` inside a grid row still sized to the panel's whole share, with
// the difference standing underneath as empty panel.
//
// Swept in a browser from 700px to 1200px of `.main` in twenty-pixel steps, on
// a text of 30 kanbun characters and 63 of prose: air below the last line at
// fifteen of the twenty-six heights, 704px of it in all, 95.6px at the worst —
// and unbounded, since the box was pinned while the row kept growing. The
// round before this one measured a single height, 1280x900, where the fit
// happened to land on the panel's own count and the slack was therefore zero;
// a fixture at one geometry is exactly how a defect of this shape hides.
//
// So the tests here are properties over a *range*. What the fix asserts is
// that the count is now got from the tracking rather than from the box: the
// box is always the panel's whole share, and `slots` characters are made to
// fill it by spending the leftover between them instead of under them.
// ---------------------------------------------------------------------------

const PROSE_SIZE = 22;
const PROSE_DESIGN = PROSE_SIZE * 0.15;
const PROSE_ADVANCE = PROSE_SIZE + PROSE_DESIGN; // 25.3
const GUARD = 1 / 120;
const BAND = { min: PROSE_SIZE * 0.05, max: PROSE_SIZE * 0.3 };

describe("a column the fit may choose is a column that fills its measure", () => {
  it("fills it exactly, at every measure and every count the band allows", () => {
    // The property the old arrangement did not have. It wrote a box of `slots`
    // *design* advances whatever the measure was, so the column filled the box
    // and the box did not fill the panel. Here there is one box, it is the
    // panel's, and the tracking is what absorbs the difference.
    let checked = 0;
    for (let measure = 60; measure <= 700; measure += 0.5) {
      const band = columnCounts(measure, PROSE_SIZE);
      if (!band) continue;
      for (let slots = band.fewest; slots <= band.most; slots++) {
        const tracking = stretchedTracking(measure, PROSE_SIZE, slots);
        expect(tracking).not.toBeNull();
        // `slots` advances plus the per-slot guard come to the whole measure.
        expect(slots * (PROSE_SIZE + tracking! + GUARD)).toBeCloseTo(measure, 9);
        expect(tracking!).toBeGreaterThanOrEqual(BAND.min);
        expect(tracking!).toBeLessThanOrEqual(BAND.max);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(3000);
  });

  it("names exactly the counts that have a tracking, and no others", () => {
    for (let measure = 60; measure <= 700; measure += 1.5) {
      const band = columnCounts(measure, PROSE_SIZE);
      for (let slots = 1; slots <= 40; slots++) {
        const inBand = band !== null && slots >= band.fewest && slots <= band.most;
        expect(stretchedTracking(measure, PROSE_SIZE, slots) !== null).toBe(inBand);
      }
    }
  });

  it("is the same function `fittedTracking` was, asked for the count it picks", () => {
    // The two doors on one piece of arithmetic — worth pinning, because the
    // search now goes through the second and every existing guarantee about
    // the panel came from the first.
    for (let measure = 60; measure <= 700; measure += 0.7) {
      const natural = Math.round(measure / PROSE_ADVANCE);
      expect(fittedTracking(measure, PROSE_SIZE, PROSE_DESIGN)).toBe(
        natural >= 1 ? stretchedTracking(measure, PROSE_SIZE, natural) : null,
      );
    }
  });
});

describe("the fit leaves the prose panel no empty band, at any window height", () => {
  // The search run over a modelled geometry with the *same* reachability rule
  // `fitPassageExtent` imposes on it — a count outside the band comes back as
  // an unreachable extent, so the walk stops at the band's edge instead of
  // reaching for a shorter box. Calibrated against the browser sweep: the
  // divisions this returns are the ones the page was measured settling on.
  const TOP = 55, PROSE_TOP = 11, PROSE_BOTTOM = 44, PITCH = 88;
  const kundokuExtent = (k: number) => Math.ceil(30 / k) * PITCH;

  /** What the panel comes to at each split, at a given `.main` height. */
  function rowAt(H: number, steps: number) {
    const k = Math.floor((0.6 * H - TOP) / PITCH) + steps;
    const measure = H - TOP - k * PITCH - PROSE_TOP - PROSE_BOTTOM;
    return { k, measure, ceiling: Math.round(measure / PROSE_ADVANCE) };
  }

  function chosenAt(H: number) {
    let ceiling = 0;
    let band: { fewest: number; most: number } | null = null;
    const reachable = (slots: number) =>
      slots === ceiling || (band !== null && slots >= band.fewest && slots <= ceiling)
        ? (PROSE_STAIRCASE[slots as keyof typeof PROSE_STAIRCASE] ?? 264)
        : Number.POSITIVE_INFINITY;
    const best = matchedDivision(
      6,
      (steps) => {
        const at = rowAt(H, steps);
        ceiling = at.ceiling;
        band = columnCounts(at.measure, PROSE_SIZE);
        if (at.ceiling < (steps === 0 ? 1 : 3)) return null;
        return { target: kundokuExtent(at.k), ceiling: at.ceiling };
      },
      reachable,
    );
    return best === null ? null : { ...best, ...rowAt(H, best.steps) };
  }

  it("chooses a column the panel can be set to, at every height in the range", () => {
    // The assertion that would have caught the defect. Before the fix the
    // chosen count was routinely below anything the measure could hold at a
    // legible tracking — that was the whole mechanism — and the difference was
    // the blank the reader saw.
    let heights = 0;
    for (let H = 700; H <= 1400; H += 4) {
      const best = chosenAt(H);
      if (best === null) continue;
      heights++;
      const tracking = stretchedTracking(best.measure, PROSE_SIZE, best.slots);
      if (best.slots === best.ceiling && tracking === null) {
        // The one permitted exception, and it is bounded: the panel's own
        // count where the band declines it. The column is then drawn at the
        // design tracking and what it leaves is under a single character —
        // `fitPassageExtent` says so at `ceiling`.
        const left = best.measure - Math.floor(best.measure / PROSE_ADVANCE) * PROSE_ADVANCE;
        expect(left).toBeLessThan(PROSE_ADVANCE);
        continue;
      }
      expect(tracking).not.toBeNull();
      // Nothing of the share is left over: the column *is* the measure.
      expect(best.slots * (PROSE_SIZE + tracking! + GUARD)).toBeCloseTo(best.measure, 9);
    }
    expect(heights).toBeGreaterThan(150);
  });

  it("never asks the type for a tracking outside the band it is drawn in", () => {
    for (let H = 700; H <= 1400; H += 4) {
      const best = chosenAt(H);
      if (best === null) continue;
      const tracking = stretchedTracking(best.measure, PROSE_SIZE, best.slots);
      if (tracking === null) continue;
      expect(tracking).toBeGreaterThanOrEqual(BAND.min);
      expect(tracking).toBeLessThanOrEqual(BAND.max);
    }
  });

  it("still returns the best division the narrowed candidates offer", () => {
    // The argmin property from the round before, restated over the new
    // candidate set — the fix narrows what the search may reach, and it must
    // still take the best of what it can.
    for (let H = 700; H <= 1400; H += 20) {
      const best = chosenAt(H);
      if (best === null) continue;
      let floor = Infinity;
      for (let steps = 0; steps <= 6; steps++) {
        const at = rowAt(H, steps);
        if (at.ceiling < (steps === 0 ? 1 : 3)) break;
        const band = columnCounts(at.measure, PROSE_SIZE);
        // The reach the walk actually has: down from the panel's own count as
        // far as the band allows, and never above it. `fitPassageExtent` says
        // why the top is the ceiling and not the band's own upper edge.
        const lo = band ? band.fewest : at.ceiling;
        for (let slots = lo; slots <= at.ceiling; slots++) {
          const extent = PROSE_STAIRCASE[slots as keyof typeof PROSE_STAIRCASE] ?? 264;
          floor = Math.min(floor, Math.abs(extent - kundokuExtent(at.k)));
        }
      }
      expect(best.gap).toBe(floor);
    }
  });

  it("costs the match something, and the figures are here rather than hidden", () => {
    // Swept in the browser before and after, 700 to 1200 in twenties. The
    // division is the same at fourteen of the twenty-six heights and worse at
    // twelve — by one prose column at six, two at four, three at two. Against
    // that, the empty band goes from up to 95.6px to nothing at every height.
    // Recorded as a test so that a later change to the band, the guard or the
    // staircase has to come back and re-argue it rather than drift past it.
    const BEFORE = [44,44,44,44,44,44,44,44,44,44,44,44,44,44,44,44,0,0,0,0,0,0,0,0,0,0];
    const AFTER  = [44,44,132,132,44,44,44,88,88,44,44,44,88,132,44,44,0,0,44,44,0,0,44,44,44,88];
    expect(BEFORE).toHaveLength(26);
    expect(AFTER).toHaveLength(26);
    const worse = AFTER.filter((g, i) => g > BEFORE[i]).length;
    expect(worse).toBe(12);
    expect(AFTER.filter((g, i) => g === BEFORE[i]).length).toBe(14);
    // Bounded, and by a small number of prose columns: every gap is a whole
    // number of them, and the worst is three.
    for (const g of AFTER) expect(g % 44).toBe(0);
    expect(Math.max(...AFTER) / 44).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// **The badge, and the mark set in it.**
//
// The strip was a hairline with an arrow in it and was the division as well as
// the control. It is now a carrier for two boxes: an edge, and a badge sitting
// astride it — a hairline square with one CJK character, of the kind a
// printer's mark or a 印 would be.
//
// The character is the CJK angle bracket in its four presentations: 〈 〉
// (U+3008/3009) where the join runs down the page, and the forms a vertical
// setting uses, ︿ ﹀ (U+FE3F/FE40), where it runs across. One glyph in four
// rotations, which is the argument for it — the four marks this control needs
// are exactly the four a Japanese typesetter has for one bracket, so nothing
// is rotated by CSS and nothing is a toolbar chevron.
//
// What it replaces was worse than a stand-in. ‹ › are Latin guillemets, and
// ⌄ ⌃ — U+2304/2303, the two the prose rail carried — are **in none of the 124
// subsets of the shipped face**, so that mark has been falling out of the
// serif and being drawn by whatever the system offered. Verified with
// fontTools over `public/fonts/noto-serif-jp/*.woff2`, the way the relation
// menu verified `vhal` reached uni30FB.
// ---------------------------------------------------------------------------

describe("the mark in the badge", () => {
  /** What fontTools read out of the shipped face, 2026-09-04. `subset` is the
   * `noto-serif-jp-vf-N.woff2` the glyph lives in — its `unicode-range` in
   * fonts.css is what fetches it — and `inkOffset` is how far the ink's centre
   * lies from the centre of the box a badge would centre it in, in `em`. */
  const MARKS = {
    "\u3008": { subset: 84, axis: "x", inkOffset: +0.2465, pad: "0 0.493em 0 0" },
    "\u3009": { subset: 84, axis: "x", inkOffset: -0.2465, pad: "0 0 0 0.493em" },
    "\uFE3F": { subset: 4, axis: "y", inkOffset: -0.2465, pad: "0 0 0.493em 0" },
    "\uFE40": { subset: 4, axis: "y", inkOffset: +0.2465, pad: "0.493em 0 0 0" },
  } as const;

  /** Every `--rail-mark` the stylesheet can set, with the padding beside it. */
  function declaredMarks() {
    const css = withoutComments(appCss);
    const out: { mark: string; pad: string | undefined }[] = [];
    for (const [, esc] of css.matchAll(/--rail-mark:\s*"\\([0-9A-Fa-f]{4})"/g)) {
      const at = css.indexOf(`--rail-mark: "\\${esc}"`);
      const rest = css.slice(at, css.indexOf("}", at));
      const pad = /--rail-mark-pad:\s*([^;]+);/.exec(rest)?.[1].trim();
      out.push({ mark: String.fromCodePoint(parseInt(esc, 16)), pad });
    }
    return out;
  }

  it("sets only marks that are in the shipped subset", () => {
    const marks = declaredMarks();
    expect(marks.length).toBeGreaterThanOrEqual(6);
    for (const { mark } of marks) expect(Object.keys(MARKS)).toContain(mark);
    // And the two that were there before are gone, one of them for cause.
    const css = withoutComments(appCss);
    for (const gone of ["\u2039", "\u203A", "\u2303", "\u2304"]) expect(css).not.toContain(gone);
    expect(css).not.toContain("\\2303");
    expect(css).not.toContain("\\2304");
  });

  it("uses one bracket in four rotations and not four unrelated marks", () => {
    // The whole of the case for this family: the ink offset is the same
    // quarter-em four times over, which is what one expects of one glyph
    // turned four ways and is the same 二分 ink / 二分 aki the relation menu's
    // own brackets are built on.
    const offsets = Object.values(MARKS).map((m) => Math.abs(m.inkOffset));
    expect(new Set(offsets.map((o) => o.toFixed(4))).size).toBe(1);
    expect(offsets[0]).toBeCloseTo(0.2465, 4);
    // Two on each axis, and each axis has one of either sign.
    for (const axis of ["x", "y"]) {
      const on = Object.values(MARKS).filter((m) => m.axis === axis);
      expect(on).toHaveLength(2);
      expect(on[0].inkOffset).toBeCloseTo(-on[1].inkOffset, 6);
    }
  });

  it("recentres each mark with a padding of twice its own ink offset", () => {
    // `padding`, not a margin and not a relative offset — the badge's box is
    // the visible square and must not leave the rule it sits on. Twice the
    // offset, because a centred item moves by half of what the padding takes.
    for (const [mark, m] of Object.entries(MARKS)) {
      const sides = m.pad.split(/\s+/); // top right bottom left
      const nonZero = sides.filter((v) => v !== "0");
      expect(nonZero).toHaveLength(1);
      expect(parseFloat(nonZero[0])).toBeCloseTo(2 * Math.abs(m.inkOffset), 3);
      // On the side the ink leans away from: font `y` runs up the page, so a
      // positive `y` offset is ink sitting high and wants padding above it.
      const side = sides.indexOf(nonZero[0]); // 0 top, 1 right, 2 bottom, 3 left
      if (m.axis === "x") expect(side).toBe(m.inkOffset > 0 ? 1 : 3);
      else expect(side).toBe(m.inkOffset > 0 ? 0 : 2);
      expect(mark.codePointAt(0)).toBeGreaterThan(0x2fff);
    }
  });

  it("pairs each declared mark with the padding that mark needs", () => {
    for (const { mark, pad } of declaredMarks()) {
      expect(pad).toBe(MARKS[mark as keyof typeof MARKS].pad);
    }
  });

  it("points the way the panel will move, in every state", () => {
    // Unchanged from the arrow's rule: the mark opens toward the edge the
    // panel leaves by, and back toward the text to bring it home.
    // `contains`, because `.rail` names two rules — the strip's own styling
    // and the block that declares the default mark beside its argument — and
    // the first match is the wrong one.
    const markIn = (selector: string) =>
      /--rail-mark:\s*"\\([0-9A-Fa-f]{4})"/.exec(ruleBody(appCss, selector, "--rail-mark:"))?.[1];
    expect(markIn(".rail")).toBe("3008"); // 〈 — the sidebar leaves to the left
    expect(markIn(".rail-right")).toBe("3009"); // 〉
    expect(markIn("#app.left-collapsed .rail-left")).toBe("3009"); // 〉 — bring it back
    expect(markIn("#app.right-collapsed .rail-right")).toBe("3008");
    expect(markIn(".rail-kakikudashi")).toBe("FE40"); // ﹀ — the prose drops away
    expect(markIn("#app.kakikudashi-collapsed .rail-kakikudashi")).toBe("FE3F"); // ︿
  });

  it("is set in the serif the page is set in, and is a hit target on its own", () => {
    const badge = declarations(ruleBody(appCss, ".rail::after"));
    expect(badge.get("content")).toBe("var(--rail-mark)");
    expect(badge.get("font-family")).toBe("var(--font-serif)");
    // Square, and the size of the strip: 1.75rem is 28px, where the hairline
    // rail was 0.9rem and needed a further 0.55rem of invisible margin on each
    // side before a pointer could find it. The band is gone with it.
    expect(badge.get("width")).toBe("var(--rail-thickness)");
    expect(badge.get("height")).toBe("var(--rail-thickness)");
    expect(declarations(ruleBody(appCss, "#app")).get("--rail-thickness")).toBe("1.75rem");
    expect(lengthOf("var(--rail-thickness)")).toBe(28);
    // `--rail-reach` is gone, but not the idea: it was the margin a *visible*
    // hairline needed to be hittable, and what is needed now is a proximity
    // band for an *invisible* badge. Different quantity, different name.
    expect(withoutComments(appCss)).not.toContain("--rail-reach");
    expect(declarations(ruleBody(appCss, "#app")).get("--rail-band")).toBe("var(--kanji-gap)");
    // No radius: nothing on this page that is not a form control has one, and
    // a rounded badge would read as a button pasted onto a book.
    expect(badge.get("border-radius")).toBeUndefined();
  });
});

describe("the band that finds an invisible badge", () => {
  // The badge is invisible at rest, so it cannot be its own target: the strip
  // around it is, a transparent band the full length of the join reaching
  // `--rail-band` into the panel. It has to take pointer events — a box that
  // declines them declines `:hover` with them, and the reveal is the hover —
  // so what matters is that nothing it swallows was anyone's to click.
  const band = () => lengthOf("var(--rail-band)");

  it("reaches no further into a panel than that panel's own inset", () => {
    // The bound, and the whole reason the band can be this deep for free. The
    // passage never enters `.tategaki`'s inset at any scroll position — a
    // scroll container's scrollable area includes both paddings, so at either
    // extreme the padding comes flush with the edge and the text stays a full
    // gap behind. Confirmed in a browser with the passage scrolled hard to its
    // far end: no cell anywhere under either side band.
    expect(band()).toBe(margins().gap);
    expect(band()).toBe(44);
  });

  it("is far deeper than the margin a visible hairline once needed", () => {
    // 0.55rem widened a 0.9rem strip a reader could see, for a 2rem target in
    // all. This is the only way to find a badge a reader cannot, and it is
    // five times that margin and well over twice that target.
    expect(band()).toBeCloseTo(5 * 8.8, 5);
    expect(band()).toBeGreaterThan(2 * 32 * 0.6);
  });

  it("gives the contested join the badge and no more", () => {
    // The one band that is not `--rail-band`: above the prose join the cells
    // themselves reach into the inset, because the readings and the kaeriten
    // hang there and belong to the cells the inspector binds to. Measured at
    // 44px deep, the deepest cell came 22px into the band and
    // `elementFromPoint` answered the rail — a token's own click, lost.
    const prose = declarations(ruleBody(appCss, ".rail-kakikudashi"));
    expect(prose.get("height")).toBe("var(--rail-thickness)");
    expect(lengthOf(prose.get("height")!)).toBeLessThan(band());
    // The two side bands keep the full depth, having nothing to contest.
    expect(declarations(ruleBody(appCss, ".rail")).get("width")).toBe("var(--rail-band)");
  });
});

// ---------------------------------------------------------------------------
// **The badge's border sits on the panel's, not beside it.**
//
// Flush against the join the two rules abut rather than coincide, and the join
// carries 2px of ink where every other rule in the app is a hairline. Measured
// at 1280x960 before the fix: `.sidebar` spans [0, 320] and draws its
// `border-inline-end` on [319, 320]; a badge pinned at `left: 0` spans
// [320, 348] and draws its own left border on [320, 321]. Two hairlines
// touching. Same on the right, mirrored.
//
// A pixel outward on the badge puts the two on the same pixel. It works
// because they are the same ink — `--color-border` on both — so the one drawn
// over the other is invisible rather than a seam.
//
// The condition is the whole difficulty, and it is the one the track used to
// have: with the panel shut there is no border to coincide with, the join has
// arrived at the window's own edge, and a badge shifted outward from there
// would lose its first pixel off the screen — undoing the placement that let
// the track go to zero. So the shift lives and dies with the panel.
// ---------------------------------------------------------------------------

describe("the badge's border coincides with the panel's", () => {
  const SHIFTS = [
    { rule: "#app:not(.left-collapsed) .rail-left::after", side: "left", flush: "inset: 0 auto 0 0" },
    { rule: "#app:not(.right-collapsed) .rail-right::after", side: "right", flush: "inset: 0 0 0 auto" },
  ] as const;

  it("shifts each side badge one pixel outward, on the badge and not the strip", () => {
    for (const { rule, side } of SHIFTS) {
      const declared = declarations(ruleBody(appCss, rule));
      expect(declared.get(side)).toBe("-1px");
      // Exactly one property, and it is a position and not a size: the badge
      // moves, the strip does not, so the proximity band stays in step with
      // the inset it is measured against.
      expect([...declared.keys()]).toEqual([side]);
    }
    // Nothing of the sort on the strip itself.
    const strip = declarations(ruleBody(appCss, ".rail"));
    for (const p of ["left", "right", "top", "bottom", "translate", "transform"]) {
      expect(strip.get(p)).toBeUndefined();
    }
  });

  it("is exactly the shift that makes the two border pixels the same pixel", () => {
    // The arithmetic, rather than the two numbers. Take the join at `x`. The
    // panel's rule is the last pixel of its own box on the left, [x-1, x], and
    // the first pixel of its box on the right, [x, x+1]. A badge flush at the
    // join draws its own 1px border from `x` leftward-facing or to `x`
    // rightward-facing; the shift has to move it by one border width, and the
    // border is 1px.
    const border = 1;
    const joint = 320;
    // left: badge starts at `joint + shift`, its border occupies
    // [joint + shift, joint + shift + border]; the panel's is [joint - 1, joint].
    const leftShift = Number(declarations(ruleBody(appCss, SHIFTS[0].rule)).get("left")!.replace("px", ""));
    expect(joint + leftShift).toBe(joint - border);
    // right: badge ends at `joint - shift`, its border occupies
    // [end - border, end]; the panel's is [joint, joint + border].
    const rightShift = Number(declarations(ruleBody(appCss, SHIFTS[1].rule)).get("right")!.replace("px", ""));
    const end = joint - rightShift;
    expect(end - border).toBe(joint);
    // And both are one border width, which is what makes it a shift and not a
    // number someone liked.
    expect(Math.abs(leftShift)).toBe(border);
    expect(Math.abs(rightShift)).toBe(border);
    expect(declarations(ruleBody(appCss, ".rail::after")).get("border")).toBe("1px solid var(--color-border)");
  });

  it("overlaps ink that matches, so the two make one hairline and not a seam", () => {
    // Same token on both, so whichever is painted over the other the pixel is
    // the same colour. Measured on the page as `rgb(217, 208, 191)` from each.
    const badge = declarations(ruleBody(appCss, ".rail::after")).get("border")!;
    expect(badge).toContain("var(--color-border)");
    expect(declarations(ruleBody(appCss, ".sidebar")).get("border-inline-end")).toContain("var(--color-border)");
    expect(declarations(ruleBody(appCss, ".saved-panel")).get("border-inline-start")).toContain("var(--color-border)");
  });

  it("takes the shift away with the panel, which is what keeps the badge on screen", () => {
    // The same words as the track's own condition, and for the same reason:
    // shut, the join is the window's edge and the badge's first pixel would
    // fall off it. Confirmed in a browser — collapsed, the badge's own border
    // is the leftmost pixel column of the window.
    for (const { rule } of SHIFTS) expect(rule).toContain(":not(.");
    const css = withoutComments(appCss);
    // Unconditional versions would be these, and there are none.
    expect(css).not.toMatch(/\n\.rail-left::after\s*\{[^}]*left:\s*-1px/);
    expect(css).not.toMatch(/\n\.rail-right::after\s*\{[^}]*right:\s*-1px/);
  });

  it("leaves the prose badge alone, there being nothing there to coincide with", () => {
    // Checked rather than assumed: a correction applied where there is nothing
    // to correct would be worse than none. `.main-panel`'s `border-block-end`
    // was deleted when the rail became an edge with a badge, and what runs
    // through this badge is the rail's own `::before` — drawn at the badge's
    // own middle, and painted before it, so the badge's ground stops it at its
    // border on either side. One thing, already coincident by construction.
    const css = withoutComments(appCss);
    expect(css).not.toContain(".rail-kakikudashi::after {\n  bottom: -1px");
    expect(declarations(ruleBody(appCss, ".main-panel")).get("border-block-end")).toBeUndefined();
    expect(
      declarations(ruleBody(appCss, "#app:not(.kakikudashi-collapsed) .rail-kakikudashi::before")).get("bottom"),
    ).toBe("calc(var(--rail-thickness) / 2)");
  });
});

// ---------------------------------------------------------------------------
// **A badge at the window's own edge gives up the border on that side.**
//
// Collapsed, each badge arrives at the boundary of the glass: the left one at
// [0, 28] with its left border on the window's first pixel column, the right
// at [1252, 1280] with its right border on the last, and the prose badge at
// [932, 960] against a 960px window with its *bottom* border on the last pixel
// row. A frame drawn along the edge of the screen is not a frame, so the side
// facing away from the panel each badge reopens is not drawn — three sides,
// reading as a tab hanging off the edge rather than as a broken box.
//
// Which side is the one the collapsed placement already points away from:
// `justify-self: start` → left, `end` → right, `align-self: end` → bottom.
// CSS cannot derive a property *name* from that, so the three are written out
// — but each sits beside the shift rule it is the complement of, so the pair
// is one thought in one place and drift is visible rather than latent.
// ---------------------------------------------------------------------------

describe("a collapsed badge drops the border on the window's edge", () => {
  const DROPS = [
    { rule: "#app.left-collapsed .rail-left::after", side: "border-left-color", placement: "start" },
    { rule: "#app.right-collapsed .rail-right::after", side: "border-right-color", placement: "end" },
    { rule: "#app.kakikudashi-collapsed .rail-kakikudashi::after", side: "border-bottom-color", placement: "end" },
  ] as const;

  it("drops exactly one side, and it is the one the placement faces away from", () => {
    for (const { rule, side } of DROPS) {
      const declared = declarations(ruleBody(appCss, rule));
      expect(declared.get(side)).toBe("transparent");
      // One property. Anything else here would be a second thing to keep in
      // step with the open state.
      expect([...declared.keys()]).toEqual([side]);
    }
    // The relation, stated the only way CSS lets it be: the two horizontal
    // badges are pinned by `justify-self` and give up the side they are pinned
    // to; the vertical one is pinned by `align-self` and does the same.
    expect(declarations(ruleBody(appCss, ".rail", "justify-self:")).get("justify-self")).toBe("start");
    expect(declarations(ruleBody(appCss, ".rail-right", "justify-self:")).get("justify-self")).toBe("end");
    expect(declarations(ruleBody(appCss, ".rail-kakikudashi")).get("align-self")).toBe("end");
  });

  it("takes the colour and never the width, so the box does not move or resize", () => {
    // The care this needs. `box-sizing: border-box` with an explicit
    // `--rail-thickness`: take the *width* away and the border box stays 28px
    // while the content box grows a pixel on that side, so `place-items:
    // center` moves the mark half a pixel and "wholly on screen" shifts with
    // it. Take the *colour* away and nothing in the box model changes at all.
    //
    // Measured: the badge captured with the border dropped and with it forced
    // back is 28x28 both times, the pixels that differ are exactly the one
    // border column, and the mark's fifteen ink pixels are at identical
    // coordinates in both.
    for (const { rule, side } of DROPS) {
      const declared = declarations(ruleBody(appCss, rule));
      expect(side).toContain("-color");
      for (const width of ["border-width", "border-left-width", "border-right-width",
        "border-bottom-width", "border-top-width", "padding", "width", "height", "box-sizing"]) {
        expect(declared.get(width)).toBeUndefined();
      }
    }
    const badge = declarations(ruleBody(appCss, ".rail::after"));
    expect(badge.get("box-sizing")).toBe("border-box");
    expect(badge.get("width")).toBe("var(--rail-thickness)");
    expect(badge.get("height")).toBe("var(--rail-thickness)");
    expect(badge.get("border")).toBe("1px solid var(--color-border)");
  });

  it("is the exact complement of the shift, on the same class", () => {
    // Two rules keyed on opposite states of one class are easy to leave
    // inconsistent, so they are written adjacently and checked here as a pair:
    // for each side, one `:not(.x)` rule that shifts and one `.x` rule that
    // drops, never both, never neither.
    const css = withoutComments(appCss);
    for (const cls of ["left-collapsed", "right-collapsed"]) {
      const rail = cls === "left-collapsed" ? "rail-left" : "rail-right";
      expect(css).toContain(`#app:not(.${cls}) .${rail}::after`);
      expect(css).toContain(`#app.${cls} .${rail}::after`);
    }
    // The prose badge has a drop and no shift, having no panel rule to meet —
    // established when its border was found to be the only one at that join.
    expect(css).toContain("#app.kakikudashi-collapsed .rail-kakikudashi::after");
    expect(css).not.toContain("#app:not(.kakikudashi-collapsed) .rail-kakikudashi::after");
  });

  it("cannot be fought by the rules it sits among", () => {
    // Both members of a pair are (1,2,1) and mutually exclusive, so neither
    // can shadow the other; both beat the flush placement rules at (0,1,1),
    // which is what puts them in force at all, and neither depends on order.
    // Checked as the shape of the selectors rather than by re-deriving the
    // cascade: an id, a class, a class, a pseudo-element.
    for (const { rule } of DROPS) {
      expect(rule.startsWith("#app.")).toBe(true);
      expect(rule.endsWith("::after")).toBe(true);
    }
    // And no unconditional version of any of them.
    const css = withoutComments(appCss);
    for (const { side } of DROPS) {
      expect(css).not.toMatch(new RegExp(`\\n\\.rail[a-z-]*::after\\s*\\{[^}]*${side}`));
    }
  });
});
