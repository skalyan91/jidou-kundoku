import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// **A custom property that script reads as a number has to compute to one.**
//
// `getComputedStyle(el).getPropertyValue("--x")` returns an *unregistered*
// custom property as the token stream it was written as. For `--head-box-size:
// 4px` that is the string `"4px"` and `parseFloat` does the obvious thing; for
// `--kanji-advance: calc(var(--size-main) + var(--kanji-gap))` it is the
// literal string `"calc(var(--size-main) + var(--kanji-gap))"`, and
// `parseFloat` of that is `NaN`.
//
// **This is not a hypothetical failure mode.** `decollideOverlay` reads exactly
// that property and gates its whole body on `advance > 0`, with a `|| 0` in
// front of the `NaN` — so from the day it was written until the registration
// this test now guards, the deprel label and the category chips were never
// moved out of each other's way on any page, while every unit test passed.
// They passed because they call `labelStandoff` and `rowStandoff` directly, and
// jsdom has no layout for an end-to-end test to measure. Nothing in the suite
// could see it; the reader could, twice.
//
// So the rule is checked here, over the source rather than over a rendered
// page: **every custom property that TypeScript parses as a number must either
// be `@property`-registered, or be declared as a bare literal in every
// stylesheet that declares it.** Either one makes `parseFloat` right; a `calc`
// or a `var` without a registration makes it silently zero.
// ---------------------------------------------------------------------------

const SRC = join(import.meta.dirname, "..", "src");

function filesUnder(dir: string, extension: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return filesUnder(path, extension);
    return path.endsWith(extension) ? [path] : [];
  });
}

const css = filesUnder(SRC, ".css").map((path) => ({ path, text: readFileSync(path, "utf-8") }));
const ts = filesUnder(SRC, ".ts").map((path) => ({ path, text: readFileSync(path, "utf-8") }));

/** Every `--x` this app registers with `@property`, and so computes. */
const registered = new Set(
  css.flatMap(({ text }) => [...text.matchAll(/@property\s+(--[a-z0-9-]+)/g)].map((m) => m[1])),
);

/** Every value this app ever declares for `--x`, across all stylesheets. */
function declarationsOf(property: string): { value: string; path: string }[] {
  return css.flatMap(({ path, text }) =>
    [...text.matchAll(new RegExp(`${property}\\s*:\\s*([^;]+);`, "g"))].map((m) => ({
      value: m[1].replace(/\s+/g, " ").trim(),
      path,
    })),
  );
}

/** A value `parseFloat` reads correctly: a plain number with an optional unit,
 * and nothing that has to be substituted or evaluated first. */
const isLiteral = (value: string) => /^-?\d*\.?\d+[a-z%]*$/.test(value);

/** Every `parseFloat(... getPropertyValue("--x") ...)` in the app, as the
 * property it reads.
 *
 * The intervening text may contain parentheses of its own — the real call is
 * `parseFloat(getComputedStyle(glyphs[0]).getPropertyValue("--kanji-advance"))`
 * — so this cannot be `[^)]*`, which was the first thing written here and
 * silently missed the one read the file exists to catch. Any characters, then,
 * stopping at the next `parseFloat` so that two nearby calls cannot be spliced
 * into one match. */
const parsedNumerically = new Set(
  ts.flatMap(({ text }) =>
    [
      ...text.matchAll(/parseFloat\((?:(?!parseFloat)[\s\S]){0,200}?getPropertyValue\(\s*"(--[a-z0-9-]+)"/g),
    ].map((m) => m[1]),
  ),
);

describe("custom properties read as numbers", () => {
  it("finds the reads it is meant to be guarding", () => {
    // The guard's own guard. A regex that stopped matching would make every
    // assertion below vacuous, and the failure would look exactly like success
    // — which is the shape of the bug this file exists for.
    expect(parsedNumerically.size).toBeGreaterThan(0);
    expect(parsedNumerically).toContain("--kanji-advance");
    expect(registered.size).toBeGreaterThan(5);
  });

  it("computes every one of them, by registration or by being a literal", () => {
    const silentlyZero = [...parsedNumerically]
      .filter((property) => !registered.has(property))
      .flatMap((property) =>
        declarationsOf(property)
          .filter(({ value }) => !isLiteral(value))
          .map(({ value, path }) => `${property}: ${value}   [${path.split("/").pop()}]`),
      );
    // Named in the failure rather than counted, because what a reader needs on
    // seeing this go red is which property and what it was declared as.
    expect(silentlyZero.join("\n")).toBe("");
  });

  it("registers --kanji-advance specifically, as a length", () => {
    // The one that was actually wrong, pinned by name so that removing the
    // registration is a deliberate act. `<length>` and not `<number>`: it is
    // a distance down the column, and an initial value is required for any
    // syntax that is not the universal one.
    const block = css
      .map(({ text }) => /@property\s+--kanji-advance\s*\{([^}]*)\}/.exec(text)?.[1])
      .find((found) => found !== undefined);
    expect(block).toBeDefined();
    expect(block).toMatch(/syntax:\s*"<length>"/);
    expect(block).toMatch(/inherits:\s*true/);
    expect(block).toMatch(/initial-value:\s*0px/);
  });

  it("leaves a property script only tests for emptiness alone", () => {
    // `--size-main` is `var(--type-max-size)` and is *not* registered, which is
    // correct: `printLayout.ts` asks only whether it is set at all
    // (`.trim() === ""`), never for its number. Registering it would give it an
    // initial value and so make that emptiness test always false — the guard
    // above is deliberately about numeric reads and not about every read.
    expect(parsedNumerically.has("--size-main")).toBe(false);
    expect(registered.has("--size-main")).toBe(false);
    expect(declarationsOf("--size-main").some(({ value }) => value.includes("var("))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// **The other way a `var()` comes to nothing: not unreadable, but unreachable.**
//
// A custom property is inherited *down*. A rule that spends one on an element
// the property is not declared on or above resolves it to nothing, the whole
// declaration is invalid at computed-value time, and the property it was
// setting falls back to its initial value — `transform: none`, `clip-path:
// none` — with no error anywhere.
//
// kunten.css has been here: `--chip-chevron` was declared on `.token-subtitle`,
// which is the chip *row's own child*, so the row's own `transform` could not
// see it. The note at the declaration records the move. The tutorial's figures
// draw the same row through `showInspector`, so they inherit both the fix and
// the hazard.
//
// What can be checked without a browser is the shape of the thing: which
// selector declares the property, and whether every selector that spends it is
// inside that one. Named rather than inferred — these are two properties and a
// handful of rules, and a general ancestor-of check over arbitrary selectors is
// a bigger and less honest piece of machinery than the invariant deserves.
// ---------------------------------------------------------------------------

/** The selectors of every top-level rule whose body declares `--x`. */
function declaringSelectors(property: string): string[] {
  return css.flatMap(({ text }) =>
    [...text.matchAll(/(^|\})\s*([^{}@]+?)\s*\{([^{}]*)\}/gm)]
      .filter(([, , , body]) => new RegExp(`(^|[\\s;])${property}\\s*:`).test(body))
      .map(([, , selector]) => selector.replace(/\s+/g, " ").trim()),
  );
}

/** The selectors of every top-level rule whose body spends `var(--x)`. */
function spendingSelectors(property: string): string[] {
  return css.flatMap(({ text }) =>
    [...text.matchAll(/(^|\})\s*([^{}@]+?)\s*\{([^{}]*)\}/gm)]
      .filter(([, , , body]) => body.includes(`var(${property})`))
      .map(([, , selector]) => selector.replace(/\s+/g, " ").trim()),
  );
}

describe("custom properties the rules that spend them can reach", () => {
  it("declares the chip geometry on the overlay, above every rule that spends it", () => {
    // `--chip-chevron` is the notch each pill cuts out of its predecessor. The
    // row spends it on its own `transform`, and the pills on their `clip-path`
    // and their padding — so it has to be declared at or above the row, and the
    // overlay is the one box that is above all of them.
    expect(declaringSelectors("--chip-chevron")).toEqual([".token-inspector-overlay"]);
    const spenders = spendingSelectors("--chip-chevron");
    expect(spenders.length).toBeGreaterThan(3);
    // Everything that spends it is a chip, a chip row, or the overlay itself —
    // which is to say, inside the element that declares it. A rule spending it
    // on anything else would be resolving it to nothing.
    for (const selector of spenders) {
      expect(selector, `${selector} spends --chip-chevron`).toMatch(
        /token-subtitle|token-inspector-overlay/,
      );
    }
  });

  it("spends the folded pill's half-chevron reserve from one property, not two", () => {
    // The reader asked twice whether the folded 品詞 pill's right padding
    // really equals its left. The first answer showed two independently
    // written `calc(var(--chip-chevron) / 2)`s that happened to agree; this
    // is the reachability half of the second answer, which is that they no
    // longer *happen* to agree — both now read `--chip-fold-reserve`, so
    // there is one division instead of two and nothing left to drift.
    // Declared beside `--chip-chevron` on the overlay, for the same reason:
    // the padding rule and the clip rule are both descendants of it and
    // neither is its own ancestor.
    expect(declaringSelectors("--chip-fold-reserve")).toEqual([".token-inspector-overlay"]);
    const spenders = spendingSelectors("--chip-fold-reserve");
    // Exactly the two rules this property exists to tie together: the
    // trailing padding that is reserved permanently, and the clip that
    // spends it back at rest. A third spender would be a new use this test
    // has not been told about; fewer would mean the tie it is guarding no
    // longer exists in the stylesheet at all.
    //
    // `endsWith` rather than an exact match: `spendingSelectors`' own regex
    // captures everything between the previous rule's `}` and the next `{`,
    // which in a file this densely commented is often a run of comment
    // blocks with no rule between them, swept up with the real selector at
    // the end — a fact about the helper visible on `--chip-chevron` too
    // (the block above matches it loosely for the same reason). The real
    // selector is still the text immediately before the `{`, so anchoring
    // on the end of the string is exact about the one thing this test is
    // actually checking.
    expect(spenders.length).toBe(2);
    for (const selector of [
      ".token-subtitle:not(:last-child)",
      ".token-subtitle-row > .token-subtitle:not(:last-child)",
    ]) {
      expect(spenders.some((spent) => spent.endsWith(selector))).toBe(true);
    }
  });

  it("declares the hairline every mark is ringed with in the same place", () => {
    // `--mark-edge` is the same story one property along: the chips' inset
    // ring, the relation label's, and the label's own padding all spend it.
    expect(declaringSelectors("--mark-edge")).toEqual([".token-inspector-overlay"]);
    for (const selector of spendingSelectors("--mark-edge")) {
      expect(selector, `${selector} spends --mark-edge`).toMatch(
        /token-subtitle|token-arrow-label|token-inspector-overlay|token-menu/,
      );
    }
  });

  it("finds the rules it is meant to be reading", () => {
    // The guard's own guard, as above: a regex that stopped matching would make
    // both assertions vacuous.
    expect(declaringSelectors("--chip-chevron").length).toBe(1);
    expect(spendingSelectors("--mark-edge").length).toBeGreaterThan(2);
  });
});
