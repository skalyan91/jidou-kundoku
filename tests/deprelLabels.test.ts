import { describe, expect, it } from "vitest";
import {
  DEPREL_INVENTORY,
  type DeprelMenuRow,
  UPOS_INVENTORY,
  deprelJa,
  deprelMenuGroups,
  deprelMenuRows,
  subtypeBracketClass,
  uposJa,
} from "../src/render/tokenInspector.ts";
import { COMMAS, FULL_STOPS, isBracket } from "../src/parse/punctuation.ts";

/** The bracket the subtype is written in, and the mark between two subtypes,
 * as literals rather than imported from the source — changing them there has
 * to be a deliberate change to these expectations too, because the choice is
 * the whole point (see `SUBTYPE_OPEN`'s doc: it is the one 隅付き括弧 the
 * annotated text can never carry). */
const OPEN = "〖";
const CLOSE = "〗";
const SEP = "・";

/** Every relation in the SUD inventory this treebank writes that carries a
 * subtype — the `base@subtype` half of the menu. Derived from the exported
 * inventory rather than typed out, so a relation added to the menu is
 * covered by these tests the moment it is added. */
const SUBTYPED = DEPREL_INVENTORY.filter((rel) => rel.includes("@"));
const PLAIN = DEPREL_INVENTORY.filter((rel) => !rel.includes("@"));

describe("the bracket subtypes are written in", () => {
  it("is one the annotated text can never carry", () => {
    // punctuation.ts's `BRACKETS` is the set of marks a source text can hold
    // and this app carries through to the panels. A label drawn over that
    // text must not use one of them, or the same mark means two things a few
    // millimetres apart. 【】 — the obvious first choice, and the one the
    // request itself illustrated with — fails exactly here.
    expect(isBracket(OPEN)).toBe(false);
    expect(isBracket(CLOSE)).toBe(false);
    expect(isBracket("【")).toBe(true);
    expect(isBracket("】")).toBe(true);
  });

  it("separates two subtypes with a mark the app never sets as punctuation", () => {
    // The same test one level down. `・` (U+30FB) is what the request was
    // written with and what Japanese uses to conjoin items inside a label —
    // but it would be a bad choice if the pipeline also *wrote* one, since
    // then a mark in a label and a mark in the text would mean two things.
    // It isn't a bracket, isn't a full stop, and isn't a comma — note that
    // `COMMAS` holds the Latin middle dot `·` (U+00B7), which is a different
    // character that this must not be confused with.
    expect(isBracket(SEP)).toBe(false);
    expect(FULL_STOPS.has(SEP)).toBe(false);
    expect(COMMAS.has(SEP)).toBe(false);
    expect(COMMAS.has("·")).toBe(true);
    expect(SEP).not.toBe("·");
  });
});

describe("deprelJa", () => {
  it("labels every relation the menu offers, in Japanese", () => {
    // Walking the inventory, not a list of examples: this is what stops a
    // relation being filed into `DEPREL_GROUPS` without a base name or a
    // subtype gloss and rendering as its raw SUD string in a menu of
    // Japanese.
    for (const rel of DEPREL_INVENTORY) {
      const label = deprelJa(rel);
      expect(label, rel).not.toBe(rel);
      expect(label, rel).not.toMatch(/[A-Za-z@:]/);
    }
  });

  it("leaves a relation with no subtype exactly as it was", () => {
    // No empty bracket, no bracket at all: the bracket appears where SUD
    // wrote an `@` and nowhere else.
    for (const rel of PLAIN) {
      expect(deprelJa(rel), rel).not.toContain(OPEN);
      expect(deprelJa(rel), rel).not.toContain(CLOSE);
    }
    expect(deprelJa("mod")).toBe("修飾語");
    expect(deprelJa("subj")).toBe("主語");
    expect(deprelJa("ROOT")).toBe("文の主辞");
  });

  it("writes every subtyped relation as its base's own name plus a bracket", () => {
    // The property that makes the menu read as one inventory rather than
    // thirty-four unrelated names: a subtyped relation's label *begins* with
    // the label of the relation it is a subtype of, so mod, mod@tmod and
    // mod@lmod are visibly three of a kind.
    for (const rel of SUBTYPED) {
      const [base] = rel.split("@");
      const label = deprelJa(rel);
      expect(label, rel).toMatch(new RegExp(`^${deprelJa(base)}${OPEN}.+${CLOSE}$`));
    }
  });

  it("draws the same distinction the same way wherever it is drawn", () => {
    // `@lmod` narrows three different relations and `@tmod` three; the
    // factoring is what makes those visibly the same narrowing rather than
    // three coincidences (場所の斜格補語, 場所修飾語 and 未分類の場所修飾語 were
    // the three previous labels, which shared nothing on the page).
    const gloss = (rel: string) => deprelJa(rel).slice(deprelJa(rel).indexOf(OPEN));
    expect(new Set(["comp:obl@lmod", "mod@lmod", "udep@lmod"].map(gloss)).size).toBe(1);
    expect(new Set(["mod@tmod", "udep@tmod"].map(gloss)).size).toBe(1);
    expect(new Set(["comp@expl", "unk@expl"].map(gloss)).size).toBe(1);
  });

  it("writes the relations of 酒蟲 as expected", () => {
    // The four subtyped relations that actually occur in the user's own
    // tree, spelled out — the tests above are properties, and one worked
    // example of each keeps the properties honest about what they produce.
    expect(deprelJa("mod@tmod")).toBe("修飾語〖時間〗");
    expect(deprelJa("mod@lmod")).toBe("修飾語〖場所〗");
    expect(deprelJa("discourse@sp")).toBe("談話標識〖文末〗");
    expect(deprelJa("flat@vv")).toBe("並列構成要素〖動詞連続〗");
    // And one the tree does not carry, where the base is itself never
    // written bare: SUD always subtypes `comp`, so 補語 exists only to be
    // the thing 〖形式〗 narrows.
    expect(deprelJa("comp@expl")).toBe("補語〖形式〗");
  });

  it("shows a relation it does not know raw rather than half-translated", () => {
    // A label that claimed to know what `foo` is would be worse than one
    // that admits it doesn't.
    expect(deprelJa("foo")).toBe("foo");
    expect(deprelJa("foo@lmod")).toBe("foo@lmod");
    // A *known* base with an unknown subtype keeps the bracket and shows the
    // subtype as SUD wrote it — the base is still correctly named, and the
    // raw tag in the bracket is exactly as much as is known.
    expect(deprelJa("mod@wat")).toBe("修飾語〖wat〗");
  });

  it("only ever splits on the first @", () => {
    expect(deprelJa("mod@tmod@x")).toBe("修飾語〖tmod@x〗");
  });
});

describe("deprelMenuRows", () => {
  /** The menu as it is actually built, but as data: `deprelMenuRows` is pure
   * precisely so that the mapping from a click to a relation can be walked
   * over the entire inventory here, with no DOM anywhere in this suite. Every
   * property below is a statement about what the reader will be able to point
   * at in the open menu. */
  const ROWS = deprelMenuRows(DEPREL_INVENTORY);

  /** What one row reads as, end to end — the string a reader sees on that
   * line, brackets and separators included. */
  const rowText = (row: DeprelMenuRow) => row.segments.map((s) => s.text).join("");
  /** The relations that row offers, in the order they are drawn. */
  const picks = (row: DeprelMenuRow) => row.segments.flatMap((s) => (s.kind === "relation" ? [s.value] : []));
  /** The subtyped relations of a row — everything after the base name. */
  const subtypesOf = (row: DeprelMenuRow) => picks(row).filter((v) => v !== row.base);

  it("collapses the flat inventory to one row per base relation", () => {
    // The whole point of the change, stated as a number: thirty-four entries
    // become twenty-three rows, and 修飾語, 修飾語〖時間〗 and 修飾語〖場所〗
    // stop being three unrelated lines in a column.
    expect(DEPREL_INVENTORY.length).toBe(34);
    expect(ROWS.length).toBe(23);
    expect(new Set(ROWS.map((r) => r.base)).size).toBe(ROWS.length);
  });

  it("offers every relation in the inventory exactly once, and offers nothing else", () => {
    // The property that makes the nested menu a rearrangement rather than a
    // narrowing: nothing a reader could pick before has become unreachable,
    // and nothing new has appeared that SUD would not accept.
    const offered = ROWS.flatMap(picks);
    expect(new Set(offered).size).toBe(offered.length);
    expect(new Set(offered)).toEqual(new Set(DEPREL_INVENTORY));
  });

  it("keeps the inventory's own order, which is the order the menu is read in", () => {
    // Stronger than the set equality above, and deliberately so. Rows come out
    // in order of a base's first appearance and subtypes in the order given,
    // so this holds exactly as long as `DEPREL_GROUPS` writes a base and its
    // subtypes contiguously. If someone later interleaves them — `mod`, `det`,
    // `mod@tmod` — the menu would silently pull `mod@tmod` back up beside
    // `mod` and `DEPREL_GROUPS` would stop describing the visible order. This
    // failing is that warning.
    expect(ROWS.flatMap(picks)).toEqual([...DEPREL_INVENTORY]);
  });

  it("reads exactly as the chip does, wherever a row holds a single relation", () => {
    // The tie between the arrow label over the character and the menu it
    // opens. A row with no subtype must read as `deprelJa(base)`; a row with
    // one must read as `deprelJa(base@subtype)` — so right-clicking a chip
    // that says 談話標識〖文末〗 lands on a row that says 談話標識〖文末〗.
    for (const row of ROWS) {
      const subtypes = subtypesOf(row);
      if (subtypes.length === 0) expect(rowText(row), row.base).toBe(deprelJa(row.base));
      else if (subtypes.length === 1) expect(rowText(row), row.base).toBe(deprelJa(subtypes[0]));
    }
  });

  it("spells a segment so that the base name plus its own bracket is the composed label", () => {
    // The general form of the tie above, which holds for rows carrying two or
    // three subtypes as well: every subtype segment, read together with the
    // base segment at the head of its row, composes exactly the string
    // `deprelJa` gives that relation. This is what lets a reader who knows the
    // chip find the segment, and a reader who clicked the segment recognise
    // the chip that replaces it.
    for (const row of ROWS) {
      const base = row.segments[0];
      expect(base.kind, row.base).not.toBe("punct");
      for (const segment of row.segments.slice(1)) {
        if (segment.kind !== "relation") continue;
        expect(deprelJa(segment.value), segment.value).toBe(`${base.text}${OPEN}${segment.text}${CLOSE}`);
      }
    }
  });

  it("writes the rows of 酒蟲 as expected", () => {
    // The four subtyped relations the user's own tree carries, as whole rows —
    // the properties above say what must be true of every row, and these say
    // what three of them actually look like.
    const row = (base: string) => ROWS.find((r) => r.base === base)!;
    expect(rowText(row("mod"))).toBe("修飾語〖時間・場所〗");
    expect(picks(row("mod"))).toEqual(["mod", "mod@tmod", "mod@lmod"]);
    expect(rowText(row("flat"))).toBe("並列構成要素〖動詞連続・外来語〗");
    expect(picks(row("flat"))).toEqual(["flat", "flat@vv", "flat@foreign"]);
    expect(rowText(row("discourse"))).toBe("談話標識〖文末〗");
    expect(picks(row("discourse"))).toEqual(["discourse", "discourse@sp"]);
    // And the longest row in the menu, which is now what very nearly decides
    // the menu's height — see `openRetagMenu`'s note on `tallestChild`.
    expect(Math.max(...ROWS.map((r) => rowText(r).length))).toBe(16);
    expect(rowText(row("flat")).length).toBe(16);
    // The other figure `openRetagMenu`'s sizing arithmetic rests on: the whole
    // menu's inline extent is the sum of these, and it fell from 202
    // characters over 34 entries to 143 over 23 rows.
    expect(ROWS.reduce((n, r) => n + rowText(r).length, 0)).toBe(143);
    expect(DEPREL_INVENTORY.reduce((n, rel) => n + deprelJa(rel).length, 0)).toBe(202);
  });

  it("draws a base SUD never writes bare, without offering it", () => {
    // `comp` is in `DEPREL_JA` only so that 〖形式〗 has something to narrow:
    // every `comp` in this treebank is `comp:obj`, `comp:obl`, `comp:pred`,
    // `comp:aux` or `comp@expl`. 補語 therefore has to be *drawn* — 〖形式〗
    // alone would name nothing — but must not be pickable, and the menu
    // decides that by looking, not by a list kept by hand.
    const labelled = ROWS.filter((r) => r.segments[0].kind === "label");
    expect(labelled.map((r) => r.base)).toEqual(["comp"]);
    expect(rowText(labelled[0])).toBe("補語〖形式〗");
    expect(picks(labelled[0])).toEqual(["comp@expl"]);
    // And the converse, which is the part that would rot silently: every
    // other base leads its row as an ordinary option, because SUD does write
    // all of them bare.
    for (const row of ROWS) {
      const leads = row.segments[0];
      expect(leads.kind === "relation", row.base).toBe(DEPREL_INVENTORY.includes(row.base));
    }
  });

  it("never offers a relation the inventory does not contain", () => {
    // The guarantee behind "a label-only base cannot be marked as current":
    // only `relation` segments carry a value the DOM will compare the token's
    // own tag against, and every one of those is a real inventory relation.
    for (const row of ROWS) {
      for (const segment of row.segments) {
        if (segment.kind === "relation") expect(DEPREL_INVENTORY, segment.value).toContain(segment.value);
        if (segment.kind === "label") expect(DEPREL_INVENTORY, segment.value).not.toContain(segment.value);
      }
    }
  });

  it("puts the brackets and the ・ in punctuation segments and nowhere else", () => {
    // The brackets and the separator belong to no relation, so they are their
    // own segments: not clickable, not shaded by any likelihood, and never
    // stuck onto the end of a name where a click on one would apply the other.
    for (const row of ROWS) {
      const subtypes = subtypesOf(row);
      const punct = row.segments.flatMap((s) => (s.kind === "punct" ? [s.text] : []));
      for (const text of punct) expect([OPEN, CLOSE, SEP], row.base).toContain(text);
      // Balanced, and only where SUD wrote an `@`: no empty bracket on a row
      // with nothing to narrow it.
      expect(punct.filter((t) => t === OPEN).length, row.base).toBe(subtypes.length > 0 ? 1 : 0);
      expect(punct.filter((t) => t === CLOSE).length, row.base).toBe(subtypes.length > 0 ? 1 : 0);
      expect(punct.filter((t) => t === SEP).length, row.base).toBe(Math.max(0, subtypes.length - 1));
      // A name is an atom. If a bracket ever ended up inside one, the segment
      // it is in would be clickable and the reader would have no way to tell
      // where one relation stopped and the next began.
      for (const segment of row.segments) {
        if (segment.kind === "punct") continue;
        for (const mark of [OPEN, CLOSE, SEP]) expect(segment.text, segment.value).not.toContain(mark);
      }
    }
  });

  it("names every segment in Japanese", () => {
    // The same guard `deprelJa` gets, one level down: a base with no name or a
    // subtype with no gloss would put `flat@vv` in a menu of Japanese, and now
    // it would put it inside a bracket where it would read as a third kind of
    // thing entirely.
    for (const row of ROWS) {
      for (const segment of row.segments) {
        expect(segment.text, row.base).not.toMatch(/[A-Za-z@:]/);
      }
    }
  });

  it("gives every segment a target at least two characters long", () => {
    // The pure stand-in for a thing only a browser can really judge. A segment
    // is a vertical run set at 1.25rem, so its extent along the column *is*
    // its character count times the em — two characters is about 40px, which
    // is a comfortable mouse target; one would be 20px, which is not, and
    // nobody would notice until they tried to click it. Every gloss in
    // `DEPREL_SUBTYPE_JA` is two characters or more today and this is the
    // thing to check before adding a one-character one.
    for (const row of ROWS) {
      for (const segment of row.segments) {
        if (segment.kind === "punct") continue;
        expect(segment.text.length, `${row.base} / ${segment.text}`).toBeGreaterThanOrEqual(2);
      }
    }
  });

  it("builds the same rows a group at a time as it does over the whole inventory", () => {
    // Which is only true because no base is split across two headings. If
    // `mod` were filed under 修飾 and `mod@tmod` under 未分類, the menu — which
    // is built per group — would draw two 修飾語 rows in two different columns,
    // and a reader would have no way to see they are one relation. The module
    // warns about this at load; this is the same check with teeth.
    //
    // Against the rows the menu *offers*, not the whole filing: `punct` is
    // filed under 談話・その他 and hidden from the menu, because a mark cannot
    // be reached to be edited (see `UNEDITABLE_DEPRELS` in tokenInspector.ts).
    // Passing it as the current relation is what puts it back, and the two
    // builds agree again — which is the same property, checked on the menu
    // that includes every row.
    const offeredRows = ROWS.filter((row) => row.base !== "punct");
    expect(deprelMenuGroups().flatMap(([, rows]) => rows)).toEqual(offeredRows);
    expect(deprelMenuGroups("punct").flatMap(([, rows]) => rows)).toEqual(ROWS);
    expect(deprelMenuGroups().map(([heading]) => heading)).toEqual(["述語・項", "修飾", "複合・並列", "談話・その他", "未分類"]);
  });

  it("degrades the way deprelJa does when it meets something it doesn't know", () => {
    // Not part of the shipped inventory, but the menu builder has to survive a
    // CoNLL-U upload whose tagset is wider than this one. An unknown base or
    // gloss shows raw rather than being dropped, and the row's shape is still
    // a shape a reader can act on.
    const rows = deprelMenuRows(["mod", "mod@wat", "zzz", "zzz@tmod"]);
    expect(rows.map((r) => rowText(r))).toEqual(["修飾語〖wat〗", "zzz〖時間〗"]);
    expect(rows.map((r) => picks(r))).toEqual([
      ["mod", "mod@wat"],
      ["zzz", "zzz@tmod"],
    ]);
  });
});

// `shadeMenuItems` no longer shades the brackets, the ・ or a label-only base
// at all: they carry no relation, so there is no probability to ask for, and a
// menu whose opacity means "how likely" had nothing to say about them. They are
// told apart from the options by colour instead (`--color-ink-soft`, the ink
// the group headings already use), which is legible at any shading level —
// see `shadeMenuItems` for the contrast figures and `.token-menu-punct` in
// kunten.css. That a tag the model cannot emit gets the same shade as a
// vanishingly unlikely one is pinned in `tests/menuShading.test.ts` and not
// restated here.

describe("uposJa", () => {
  it("labels every tag the POS menu offers, in Japanese", () => {
    for (const tag of UPOS_INVENTORY) {
      expect(uposJa(tag), tag).not.toBe(tag);
      expect(uposJa(tag), tag).not.toMatch(/[A-Za-z]/);
    }
  });

  it("brackets nothing, because UPOS has no subtypes to bracket", () => {
    // UPOS is a flat tagset: NOUN/PROPN/PRON are seventeen coordinate tags,
    // not a coarse tag and its refinements, and nothing in this menu is
    // written `base@subtype`. The treebank's own four-field xpos
    // (`v,動詞,描写,形質`) *is* hierarchical, but no menu in this app offers
    // it, so there is nothing there to bracket either. If an xpos menu is
    // ever added, this expectation is the one to come back and change.
    for (const tag of UPOS_INVENTORY) {
      expect(uposJa(tag), tag).not.toContain(OPEN);
      expect(tag).not.toContain("@");
    }
  });
});

/** The recentring the two brackets need in vertical setting, as a mapping from
 * the character to the class that carries it.
 *
 * The correction itself is CSS and its size came from the font (see
 * `.subtype-bracket-open` in kunten.css: measured with fontTools, both
 * vertical alternates sit about 0.29em off the centre of their own em cell,
 * hugging the edge that faces the text they enclose). What is testable here is
 * the part that is a decision rather than a measurement — that every bracket a
 * row draws is claimed by the correction and nothing else is — and it is worth
 * testing over the inventory rather than over the three characters the
 * function is written against, because a row that grew a second kind of
 * punctuation would otherwise pick up the wrong offset silently.
 *
 * Whether the result *looks* centred is not checked, here or anywhere: there
 * was no browser in which to look at it. */
describe("subtypeBracketClass", () => {
  it("claims both brackets and nothing else, over every row in the inventory", () => {
    const seen = new Set<string>();
    for (const row of deprelMenuRows(DEPREL_INVENTORY)) {
      for (const segment of row.segments) {
        if (segment.kind !== "punct") {
          // A relation's own name is text, never a mark to be nudged.
          expect(subtypeBracketClass(segment.text), segment.text).toBe("");
          continue;
        }
        seen.add(segment.text);
        const expected =
          segment.text === OPEN
            ? "subtype-bracket-open"
            : segment.text === CLOSE
              ? "subtype-bracket-close"
              : "";
        expect(subtypeBracketClass(segment.text), segment.text).toBe(expected);
      }
    }
    // And that the inventory does in fact exercise all three cases, so the
    // loop above is not vacuously passing on a menu that has lost its
    // brackets.
    expect([...seen].sort()).toEqual([SEP, OPEN, CLOSE].sort());
  });

  it("leaves the ・ alone, because it is centred already", () => {
    // Measured in the shipped subset: U+30FB's ink is y ∈ [295, 465] in a cell
    // that runs [-120, 880], so its centre is exactly the cell's. A nudge
    // there would be introducing the very error the brackets need undone.
    expect(subtypeBracketClass(SEP)).toBe("");
  });
});

/** The four rows the help modal's 係り受け figure shows, which it picks out of
 * the real first group rather than hand-building (see `deprelMenu` in
 * HelpModal.ts). The figure exists to show that a row carries its subtypes
 * inline, so there has to *be* a subtyped row in that group to show, and three
 * plain ones to set it against. */
describe("the rows the help figure draws from", () => {
  it("gives the first category a subtyped row and three plain ones", () => {
    const [, rows] = deprelMenuGroups()[0];
    const subtyped = rows.filter((row) => row.segments.length > 1);
    expect(subtyped.length).toBeGreaterThanOrEqual(1);
    expect(rows.length - subtyped.length).toBeGreaterThanOrEqual(3);
  });
});
