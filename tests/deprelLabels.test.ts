import { describe, expect, it } from "vitest";
import {
  DEPREL_INVENTORY,
  EMPTY_FIELD_LABEL,
  type DeprelMenuRow,
  deprelJa,
  deprelMenuGroups,
  deprelMenuRows,
  posChipParts,
  subtypeBracketClass,
  uposJa,
} from "../src/render/tokenInspector.ts";
import { XPOS_INVENTORY, uposForXpos } from "../src/parse/xpos.ts";
import { COMMAS, FULL_STOPS, isBracket } from "../src/parse/punctuation.ts";
import en from "../src/i18n/en.json" with { type: "json" };
import ja from "../src/i18n/ja.json" with { type: "json" };

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
    // **The headings, and the order they stand in**, which is a handbook's:
    // 数研出版『体系漢文』files the sentence into 基本成分 {主語, 述語, 目的語}
    // and 修飾成分 {連体修飾語, 前置連用修飾語, 後置修飾語（補語）}, and
    // `DEPREL_GROUPS` sets out at length which relation answers to which of the
    // six, what the handbook has no word for, and where each of those went.
    // Six headings where there were five: the group that held the compounds
    // beside the coordinators was split, a coordinator being a sentence element
    // (接続語) and a compound being a fact about a word.
    //
    // Seven now, not six: the reader's later instruction put ROOT in a
    // singleton category of its own, first — "述語", the handbook's own word
    // for the one relation that lives there (`DEPREL_GROUPS`'s own doc argues
    // the filing, and the promotion, at length).
    expect(deprelMenuGroups().map(([heading]) => heading)).toEqual([
      "述語",
      "基本成分",
      "修飾成分",
      "接続・並列",
      "談話・その他",
      "複合語",
      "未分類",
    ]);
    // ROOT's own singleton group, first and alone.
    expect(deprelMenuGroups()[0][1].map((row) => row.base)).toEqual(["ROOT"]);
    // And the relations under the two the handbook names, in the handbook's
    // own sequence — 主語 → 述語 → 目的語, then the modifiers with 補語 last.
    // This is the assertion that would catch a re-sort by frequency or by
    // name, which is what the instruction ruled out. ROOT itself is gone from
    // this group now — it answered to 述語 here, and 述語 is what the group
    // above is named for it.
    expect(deprelMenuGroups()[1][1].map((row) => row.base)).toEqual([
      "subj",
      "comp:obj",
      "comp:pred",
      "comp:aux",
      "comp",
    ]);
    expect(deprelMenuGroups()[2][1].map((row) => row.base)).toEqual(["mod", "det", "clf", "comp:obl"]);
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

/** **The three category chips**, and what became of the bracket that was here.
 *
 * ── What this block replaces, three times over ───────────────────────────
 * It began as a `uposJa` block asserting that the 品詞 menu's labels contained
 * no 〖 at all, on the ground that UPOS is a flat tagset with nothing to
 * bracket. Its own comment named what would end it: *"The treebank's own
 * four-field xpos (`v,動詞,描写,形質`) is hierarchical, but no menu in this app
 * offers it… If an xpos menu is ever added, this expectation is the one to
 * come back and change."* An xpos menu was added, and it was inverted: the
 * chip composed 動詞〖行為・動作〗 in the deprel label's own 〖〗, and every
 * semantic pair the treebank records got a bracket.
 *
 * A reader then saw that chip on a page and reported it as too small to read,
 * which is the only measurement of a chip that is worth anything. It was
 * split into two pills, 品詞 over 行為・動作, and was still too small. It is
 * three pills now, and the third split is not a compromise about length but
 * the tag's own shape: **the semantic pair is a hierarchy, not a compound** —
 * 行為 is a domain and 動作 is one of the fourteen senses inside it — so the
 * `・` that joined them was a compound's mark standing in for a parent's.
 *
 * **The bracket and the ・ are both gone from the chips**, with the
 * composition that needed them: they exist to say that one thing narrows
 * another, and three pills say that by position. So the expectation inverts a
 * third time and lands where it started — the 〖 is the deprel label's alone
 * again, which is where it came from and where the font measurements behind
 * `subtypeBracketClass` were made.
 *
 * What is checked here is the *display layer's* division of labour: which
 * field each chip says, what happens where a field is `*`, and the three
 * bounds the three chips are sized against. xpos.ts's own field handling is
 * that module's and is checked in `tests/xpos.test.ts`.
 *
 * Figures throughout are the shipped `src/parse/xpos-inventory.json`, which
 * `scripts/build-xpos-inventory.py` counted off the whole Kyoto treebank —
 * 533 362 tokens, 121 tags, 11 syntactic prefixes, 45 domains, 83 senses. */
describe("posChipParts", () => {
  const token = (xpos: string, pos = "VERB") => ({ pos, xpos });

  it("gives every attested tag one chip per field it records", () => {
    // The walk, not the examples: a tag the inventory grew that this file
    // could not take apart would draw a chip with no text in it.
    for (const xpos of XPOS_INVENTORY) {
      const fields = xpos.split(",");
      const parts = posChipParts(token(xpos));
      expect(parts.word, xpos).toBe(fields[1]);
      expect(parts.domain, xpos).toBe(fields[2] === "*" ? undefined : fields[2]);
      expect(parts.sense, xpos).toBe(fields[3] === "*" ? undefined : fields[3]);
    }
    // **A pill reading 「なし」 was drawn here for a round and the reader
    // refused it.** The word survives — it is the sense menu's `*` row, which
    // is the "no sense" that was asked for — but it is a row and never a chip,
    // so nothing the chips draw is ever this string.
    expect(EMPTY_FIELD_LABEL).toBe("なし");
    const drawn = XPOS_INVENTORY.flatMap((xpos) => {
      const parts = posChipParts(token(xpos));
      return [parts.word, parts.domain, parts.sense];
    });
    expect(drawn).not.toContain(EMPTY_FIELD_LABEL);
    // And it could not be a field value by accident either: every field of
    // every tag in the treebank is written in kanji, which is half of why
    // 「なし」 was chosen over 無 — a character of the text being annotated.
    for (const xpos of XPOS_INVENTORY) {
      for (const field of xpos.split(",").slice(1)) {
        expect(field, xpos).not.toBe(EMPTY_FIELD_LABEL);
      }
    }
  });

  it("brackets nothing, and joins nothing, on any of the three", () => {
    // The inversion of the inversion of the inversion. Three pills, no 〖 and
    // no ・ — both marks are the deprel label's alone again. Checked over the
    // inventory rather than on an example, because what would put one back is
    // a composition step somewhere in this file and it could be added at any
    // level.
    for (const xpos of XPOS_INVENTORY) {
      const parts = posChipParts(token(xpos));
      for (const chip of [parts.word, parts.domain ?? "", parts.sense ?? ""]) {
        expect(chip, xpos).not.toContain(OPEN);
        expect(chip, xpos).not.toContain(CLOSE);
        expect(chip, xpos).not.toContain(SEP);
        expect(chip, xpos).not.toMatch(/[A-Za-z,*]/);
      }
    }
    expect(posChipParts(token("v,動詞,行為,動作"))).toEqual({ word: "動詞", domain: "行為", sense: "動作" });
    expect(posChipParts(token("n,名詞,人,その他の人名"))).toEqual({
      word: "名詞",
      domain: "人",
      sense: "その他の人名",
    });
    // And the two marks it gave up are still doing their own job next door.
    expect(deprelJa("mod@tmod")).toBe(`修飾語${OPEN}時間${CLOSE}`);
    expect(deprelJa("mod")).toBe("修飾語");
  });

  it("draws no chip for a level the treebank records nothing at", () => {
    // `*` is not a value a reader can mean — it is the treebank saying the
    // scheme records nothing there — so the chip is not drawn empty, it is not
    // drawn. `undefined` is what says so, and `""` would not: `showInspector`
    // appends each chip on a definedness test, so an empty string would put an
    // empty pill on the page.
    //
    // **A placeholder pill was tried here and refused**, and what replaced it
    // is not a compromise but a better fit for the arrangement: the two
    // semantic chips sit in a tier of their own
    // (`.token-subtitle-semantic`), so a tag that records neither simply has
    // no outer tier, and there is no hole in a stack to explain. The
    // reachability that argued for the pill is answered in the menu instead —
    // see `senseMenuValues`.
    //
    // Three tags record neither field and 27 record a domain but no sense, so
    // one chip and two chips are both ordinary states rather than edge cases.
    const noSemantics = XPOS_INVENTORY.filter((xpos) => xpos.endsWith(",*,*"));
    const domainOnly = XPOS_INVENTORY.filter((xpos) => xpos.endsWith(",*") && !xpos.endsWith(",*,*"));
    expect([...noSemantics].sort()).toEqual(["p,感嘆詞,*,*", "p,接尾辞,*,*", "s,記号,*,*"].sort());
    expect(domainOnly).toHaveLength(27);
    for (const xpos of noSemantics) {
      expect(posChipParts(token(xpos)).domain, xpos).toBeUndefined();
      expect(posChipParts(token(xpos)).sense, xpos).toBeUndefined();
    }
    for (const xpos of domainOnly) {
      expect(posChipParts(token(xpos)).domain, xpos).toBeDefined();
      expect(posChipParts(token(xpos)).sense, xpos).toBeUndefined();
    }
    expect(posChipParts(token("p,助詞,句末,*"))).toEqual({ word: "助詞", domain: "句末" });
    expect(posChipParts(token("p,接尾辞,*,*"))).toEqual({ word: "接尾辞" });
  });

  it("never records a sense without a domain to hold it", () => {
    // The shape the stack assumes: the fields are filled from the top down, so
    // a gap in the middle — a sense chip standing directly under the 品詞 chip
    // — cannot arise. Nothing in the treebank does this; it is checked because
    // the chips would show it *wrong* rather than not show it, the second pill
    // reading as a domain whatever it holds. `assertMenuLabelsComplete` checks
    // the same thing at load.
    for (const xpos of XPOS_INVENTORY) {
      const parts = posChipParts(token(xpos));
      if (parts.domain === undefined) expect(parts.sense, xpos).toBeUndefined();
    }
  });

  it("falls back to the UPOS name, on the first chip only", () => {
    // The upload path. A CoNLL-U with no XPOS column gives every token `""`,
    // and such a token still has a category — it is just that the only
    // statement of it is the UPOS one. This is the last thing `UPOS_JA` is
    // for, the menu it was written for having gone.
    expect(posChipParts(token("", "NOUN"))).toEqual({ word: "名詞" });
    expect(posChipParts(token("_", "SCONJ"))).toEqual({ word: "従属接続詞" });
    // Including the two UPOS the derivation can never produce, which only an
    // uploaded tree can bring in.
    expect(posChipParts(token("", "DET"))).toEqual({ word: "限定詞" });
    expect(posChipParts(token("", "X"))).toEqual({ word: "その他" });
    // A malformed tag is "no tag", not a tag to be partly shown.
    for (const nothing of ["", "_", "v,動詞", "v,動詞,行為,動作,余"]) {
      expect(posChipParts(token(nothing, "NOUN")), nothing).toEqual({ word: "名詞" });
    }
  });

  it("never draws an empty chip", () => {
    // The property under every branch: whatever a token wears, the first pill
    // says something. An unknown UPOS with no xpos falls through `uposJa` to
    // the raw tag, which is ugly and is not nothing.
    for (const xpos of ["", "_", "junk", ...XPOS_INVENTORY]) {
      const parts = posChipParts(token(xpos, "NOUN"));
      expect(parts.word.length, xpos).toBeGreaterThan(0);
      expect(parts.domain ?? "x", xpos).not.toBe("");
      expect(parts.sense ?? "x", xpos).not.toBe("");
    }
    expect(posChipParts(token("", "WAT")).word).toBe("WAT");
  });
});

/** **The size the apparatus is set at, and the bound that is no longer there.**
 *
 * A chip's font size used to be the clicked character's cell width over the
 * longest label any chip could draw, so that even the worst case fitted the
 * cell across. That constraint is why the size kept falling as the chip
 * learned to say more, and it is gone: the chips are laid side by side now and
 * a reader has explicitly sanctioned their overflowing the column. So there is
 * no computed bound left to assert, and what these check instead is that the
 * size is a *constant* fraction of the text — that nothing recomputes it, and
 * that a longer label makes the row wider rather than the type smaller.
 *
 * The same reader has since asked that only the 品詞 be shown by default, with
 * the domain and the sense revealed on hover, and none of the above is
 * affected: all three chips are still drawn, still side by side, still at this
 * one size. What changed is when two of them are visible and which box they
 * are laid out in (`SEMANTICS_WRAPPER` in tokenInspector.ts, and
 * tests/inspectorLayout.test.ts, where the arrangement is pinned). A size that
 * differed between the two states would be the thing to catch, and there is
 * none: the inline `font-size` is written on each chip as it is built, before
 * anything about the reveal is decided.
 *
 * The cell is the whole `.kanji-cell` — kanji+ruby+kunten, one
 * `--column-pitch`, `--size-main` × `--line-height-main` — which is **88px** at
 * the shipped scale. That figure is written into these expectations rather
 * than read from a stylesheet there is no browser here to resolve, so it is
 * stated once and referred to from the rest.
 *
 * `CHIP_SIZE_OF_CELL` is not exported and is not asserted here: it is one
 * literal in one place, and a test that imported it could only restate it.
 * What can be checked without it is the arithmetic it was chosen against, and
 * the labels it no longer has to accommodate — which is the record of the
 * constraint that was lifted, and the figures it would need if it ever came
 * back. */
describe("the size the apparatus is set at", () => {
  const CELL = 88;

  it("no longer has a bound to compute, and these are the figures it would need", () => {
    // What `MAX_CHIP_LABEL_LENGTH` was: the longest label any of the three
    // chips can draw — every field the treebank writes, plus the `UPOS_JA`
    // gloss the first chip falls back to on a token with no tag. Kept as an
    // expectation because the constraint was **lifted, not solved**: if the
    // chips are ever asked to stay inside their column again, this is the
    // number the size would have to be divided by, and 88/6 ≈ 14.67px is what
    // it would give.
    const drawable = XPOS_INVENTORY.flatMap((xpos) => {
      const parts = posChipParts({ pos: "", xpos });
      return [parts.word, parts.domain, parts.sense].filter((label) => label !== undefined);
    });
    const longest = Math.max(...[...drawable, "等位接続詞", "従属接続詞"].map((l) => l!.length));
    expect(longest).toBe(6);
    expect(CELL / longest).toBeCloseTo(14.67, 2);
    // And the two outliers that make it 6 rather than 3 — one sense in 83,
    // and a gloss only an untagged token ever shows.
    const senses = [...new Set(XPOS_INVENTORY.map((x) => posChipParts({ pos: "", xpos: x }).sense))]
      .filter((sense) => sense !== undefined);
    expect(senses.filter((sense) => sense!.length === 6)).toEqual(["その他の人名"]);
    expect(senses.filter((sense) => sense!.length === 2)).toHaveLength(70);
    expect(uposJa("CCONJ")).toBe("等位接続詞");
    expect(Math.max(...drawable.map((l) => l!.length))).toBe(6);
  });

  it("is a fifth of the cell, which is the largest this apparatus has been", () => {
    // The size chosen in place of the bound: a fifth of the cell, 17.6px, which
    // is what the old arithmetic gave back when the chip said 等位接続詞 and
    // nothing more — the one figure in the sequence that was on a page for a
    // while without being complained about. The sequence, as the chip learned
    // to say more and then learned to say it side by side:
    expect(CELL / 12).toBeCloseTo(7.33, 2); // whole tag composed into one pill
    expect(CELL / 8).toBe(11); //             two lines inside one pill
    expect(CELL / 6).toBeCloseTo(14.67, 2); // three chips stacked, one bound
    expect(CELL / 5).toBe(17.6); //           three chips in a row, no bound
    // The last is not derived from any label, which is the point: 5 is a
    // choice. It is larger than the bound the labels would impose, which is
    // exactly what "the chips may overflow" buys.
    expect(CELL / 5).toBeGreaterThan(CELL / 6);
  });

  it("is one size for all three chips, which is a decision about rank", () => {
    // The three were sized apart for a round, each against its own field's
    // longest value, and it was asked to be undone. Type size reads as rank,
    // and the sizes it produced asserted a hierarchy the tagset does not have
    // — then got it out of order, the middle chip coming out largest because
    // 45 domains happen to have short names.
    const longest = (field: "word" | "domain" | "sense") =>
      Math.max(...XPOS_INVENTORY.map((xpos) => posChipParts({ pos: "", xpos })[field]?.length ?? 0));
    expect(longest("word")).toBe(3); // 5 with the UPOS fallback: 88/5 = 17.6px
    expect(longest("domain")).toBe(3); // 88/3 ≈ 29.33px — the largest, in the middle
    expect(longest("sense")).toBe(6); // 88/6 ≈ 14.67px
    expect(longest("domain")).toBeLessThan(longest("sense"));
    expect(CELL / 3).toBeCloseTo(29.33, 2);
  });

  it("takes the deprel label with it, which was never bounded by any of this", () => {
    // The fourth mark of the apparatus. Its worst case is 12
    // (並列構成要素〖動詞連続〗) and it was deliberately never in the maximum:
    // `.token-arrow-label` is `writing-mode: vertical-rl`, so those 12
    // characters run *down* the column and the label is one character wide
    // whatever it says — nothing about a cell's width ever constrained it. It
    // takes the chips' size for the plainer reason that one apparatus should
    // be set in one size, and it is 17.6px now, which is what it was before
    // the chip ever showed an xpos (the old shared constant was 5, computed
    // from `UPOS_JA` alone).
    expect(Math.max(...DEPREL_INVENTORY.map((rel) => deprelJa(rel).length))).toBe(12);
    expect(deprelJa("flat@vv")).toBe(`並列構成要素${OPEN}動詞連続${CLOSE}`);
    expect(CELL / 5).toBe(17.6);
  });
});

describe("uposJa", () => {
  it("names every UPOS the derivation can write", () => {
    // What is left of this function's job. It no longer labels a menu — the
    // 品詞 menu offers xpos — but every tag `uposForXpos` can put on a token
    // has to have a name, because the chip falls back to it and because an app
    // should not hold a category it cannot say. `assertMenuLabelsComplete`
    // checks the same thing at load; this checks it where a failure is visible.
    const derived = [...new Set(XPOS_INVENTORY.map((xpos) => uposForXpos(xpos)))];
    expect(derived).toHaveLength(15);
    for (const upos of derived) {
      expect(uposJa(upos!), upos).not.toBe(upos);
      expect(uposJa(upos!), upos).not.toMatch(/[A-Za-z]/);
    }
  });

  it("goes on naming the two UPOS no xpos derives to", () => {
    // `DET` and `X` are not in the fifteen above and cannot be reached by any
    // edit, but an uploaded CoNLL-U can carry either and the chip has to name
    // what it is shown. Hiding a category from the menu and being unable to
    // say it are different things — which was the old menu's argument for
    // these two as well, and is the one part of it that survives.
    expect(uposJa("DET")).toBe("限定詞");
    expect(uposJa("X")).toBe("その他");
    for (const upos of XPOS_INVENTORY.map((xpos) => uposForXpos(xpos))) {
      expect(upos, String(upos)).not.toBe("DET");
      expect(upos, String(upos)).not.toBe("X");
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

/** The rows the help modal's 係り受け figure shows, which it picks out of a
 * real group rather than hand-building (see `deprelMenu` and
 * `deprelRowsShown` in HelpModal.ts). The figure exists to show that a row
 * carries its subtypes inline, so there has to *be* a subtyped row in that
 * group to show, and enough plain ones to set it against — which is exactly
 * the property a singleton group cannot have, and exactly why
 * `deprelRowsShown` no longer simply takes `deprelMenuGroups()[0]` now that
 * ROOT's own singleton sits there. This describes the group that function
 * actually reaches for, so a future reordering that changed *which* group
 * that is would have to keep this property true of it or fail here rather
 * than in a browser nobody is running.
 *
 * **The count is deliberately not pinned here, and the comment used to pin it
 * by accident** — it said "the four rows", which was true only while the figure
 * was abbreviated to two rows and a `…`, and then only of an earlier cut. The
 * figure now draws the whole group under one clamped height, so how many rows
 * it shows is `deprelMenu`'s business and the clamp's; what this file is
 * entitled to insist on is the *shape* the figure needs, which is what the
 * assertion below states and all it states. */
describe("the rows the help figure draws from", () => {
  it("is a singleton first, ROOT's own, which the figure must not reach for", () => {
    // The property that makes `deprelMenuGroups()[0]` the wrong thing for
    // `deprelRowsShown` to read any more, pinned directly rather than left to
    // be inferred from the next test passing: a group of exactly one row has
    // no subtype to show beside a plain one, whatever its own row looks like.
    const [heading, rows] = deprelMenuGroups()[0];
    expect(heading).toBe("述語");
    expect(rows.map((row) => row.base)).toEqual(["ROOT"]);
  });

  it("gives the group the figure actually draws a subtyped row and three plain ones", () => {
    const groups = deprelMenuGroups();
    const [, rows] = groups.find(([, groupRows]) => groupRows.length > 1)!;
    const subtyped = rows.filter((row) => row.segments.length > 1);
    expect(subtyped.length).toBeGreaterThanOrEqual(1);
    expect(rows.length - subtyped.length).toBeGreaterThanOrEqual(3);
  });
});

/** ROOT's own group is a literal Japanese heading in `DEPREL_GROUPS`, not
 * one read through `t()` — `DEPREL_GROUPS`'s own doc argues why: every other
 * relation and 品詞 name in this app is fixed grammatical terminology
 * whatever the UI language is showing, and this one heading is no exception
 * just because it is new. What the reader asked for — "a heading in both
 * languages" — is instead a bilingual *record*, kept in the same two files
 * every other UI string lives in. This is the ratchet on that record: it
 * would not fail if the menu heading itself changed (that is
 * `deprelMenuGroups`'s test above), only if the bilingual pair went missing
 * or drifted from the word the menu actually shows. */
describe("the root category's heading, recorded in both languages", () => {
  it("names 述語 in ja.json and its English gloss in en.json", () => {
    expect(ja).toHaveProperty("deprel.group.root.heading", "述語");
    expect(en).toHaveProperty("deprel.group.root.heading", "Predicate");
    // And agrees with what the menu itself is headed with — the point of
    // keeping the record at all.
    expect((ja as Record<string, string>)["deprel.group.root.heading"]).toBe(deprelMenuGroups()[0][0]);
  });
});
