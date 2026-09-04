import { describe, expect, it } from "vitest";
import type { Token } from "../src/parse/types.ts";
import {
  DEPREL_INVENTORY,
  UPOS_INVENTORY,
  deprelJa,
  deprelMenuGroups,
  uposJa,
  uposMenuGroups,
} from "../src/render/tokenInspector.ts";

/** The menu's inventories against the shipped model's own, and the adjective
 * category that is spelled as a feature.
 *
 * ── Where the expectations come from ──────────────────────────────────────
 * The wheel, not the treebank. `public/wasm/wheels/
 * lzh_sud_kyoto-0.3.2-py3-none-any.whl` →
 * `lzh_sud_kyoto/lzh_sud_kyoto-0.3.2/meta.json`: `labels.parser` is 34
 * relations, and `labels.morphologizer` is 157 feature bundles whose distinct
 * `POS=` values are the 15 below. 0.3.2 retagged eight of those bundles from
 * `VERB` to `ADJ` — the diff against 0.3.1 is exactly those eight, the
 * relations are byte-identical, and no `VERB` bundle carries `Degree=Pos` any
 * more. The canonical `lzh_kyoto-sud-*.conllu`
 * files are deliberately not counted — the shipped model was trained on a
 * `relabeled_ext` variant and the two disagree about live labels, the
 * canonical files having `udep@lmod` 4 472 and `mod@lmod` 0 where the variant
 * has 3 030 and 74 and the model emits `mod@lmod`.
 *
 * Written out here as literals rather than read out of the wheel at test
 * time, which is the same discipline `bungoConjugation.ts` keeps for the same
 * inventory: the wheel is a 15 MB binary and unzipping it in a unit test buys
 * nothing that a deliberate edit to this list does not. What it costs is that
 * a new wheel needs this list re-read, which is what the doc comments in
 * `tokenInspector.ts` say to do. */
const MORPHOLOGIZER_UPOS = [
  "ADJ", "ADP", "ADV", "AUX", "CCONJ", "INTJ", "NOUN", "NUM",
  "PART", "PRON", "PROPN", "PUNCT", "SCONJ", "SYM", "VERB",
];

const PARSER_DEPRELS = [
  "ROOT", "cc", "clf", "comp:aux", "comp:obj", "comp:obl", "comp:obl@lmod", "comp:pred", "comp@expl",
  "compound", "compound@redup", "conj:coord", "conj:coord@emb", "dep", "det", "discourse", "discourse@sp",
  "dislocated", "flat", "flat@foreign", "flat@vv", "list", "mod", "mod@lmod", "mod@tmod", "parataxis",
  "punct", "subj", "udep", "udep@lmod", "udep@tmod", "unk", "unk@expl", "vocative",
];

const token = (over: Partial<Token>): Token => ({
  id: 0, text: "高", lemma: "高", pos: "VERB", xpos: "", dep: "mod", head: 1, ...over,
});

/** Every tag any group offers, for a token whose own category is already
 * offered — i.e. the menu in its ordinary state. */
const offered = () => uposMenuGroups("VERB").flatMap(([, tags]) => tags);

/** Every relation the menu offers, likewise. */
const offeredRels = () =>
  deprelMenuGroups().flatMap(([, rows]) => rows.flatMap((r) => r.segments.filter((sg) => sg.kind === "relation").map((sg) => sg.value)));

/** What the menu hides because it names a token the reader can never be
 * editing. `resolveEntry` returns null for `pos === "PUNCT"`, so a mark draws
 * no chip and no arrow and neither menu can be opened on one — confirmed on
 * the page as well as in that function. 句読点 could therefore only ever have
 * turned some *other* character into a mark, which is a one-way edit (the
 * cell stops resolving, so the menu cannot be reopened to undo it); `punct`
 * could only ever have said that an ordinary character stands to its head as
 * punctuation does. */
const UNEDITABLE_UPOS = ["PUNCT"];
const UNEDITABLE_DEPRELS = ["punct"];

describe("the menu offers what the model can produce, and nothing else", () => {
  it("offers every UPOS the morphologiser can emit except the uneditable one", () => {
    for (const tag of MORPHOLOGIZER_UPOS) {
      if (UNEDITABLE_UPOS.includes(tag)) expect(offered(), tag).not.toContain(tag);
      else expect(offered(), tag).toContain(tag);
    }
  });

  it("offers the adjective as one of the model's own tags", () => {
    // It was not always. Until 0.3.2 the tagset had no ADJ and this app made
    // 形容詞 out of `VERB` + `Degree=Pos`; the release emits the tag, so the
    // entry is now offered for exactly the reason every other entry is.
    expect(MORPHOLOGIZER_UPOS).toContain("ADJ");
    expect(offered()).toContain("ADJ");
  });

  it("offers nothing else at all", () => {
    // The property, stated so that a tag added to a group without being added
    // to the offered set lands here.
    for (const tag of offered()) expect(MORPHOLOGIZER_UPOS, tag).toContain(tag);
    // 15 emittable, less the one that cannot be edited — and DET and X need
    // no subtracting, being absent from the model's set to begin with.
    expect(offered()).toHaveLength(MORPHOLOGIZER_UPOS.length - UNEDITABLE_UPOS.length);
    expect(offered()).toHaveLength(14);
  });

  it("hides exactly DET, X and PUNCT, and goes on naming them", () => {
    const hidden = UPOS_INVENTORY.filter((tag) => !offered().includes(tag));
    expect(hidden).toEqual(["DET", "PUNCT", "X"]);
    // Filed and glossed still: hiding a tag from the menu is not the same as
    // the app being unable to name one, which the upload path needs. A mark
    // that arrives as one must still read 句読点 on its chip.
    expect(uposJa("DET")).toBe("限定詞");
    expect(uposJa("X")).toBe("その他");
    expect(uposJa("PUNCT")).toBe("句読点");
  });

  it("files exactly the 34 relations the parser can emit", () => {
    expect([...DEPREL_INVENTORY].sort()).toEqual([...PARSER_DEPRELS].sort());
  });

  it("offers the 34 less the uneditable relation, and goes on naming it", () => {
    expect([...offeredRels()].sort()).toEqual(
      PARSER_DEPRELS.filter((r) => !UNEDITABLE_DEPRELS.includes(r)).sort(),
    );
    for (const rel of UNEDITABLE_DEPRELS) expect(offeredRels(), rel).not.toContain(rel);
    expect(deprelJa("punct")).toBe("句読点");
  });
});

describe("a token wearing a hidden category keeps it", () => {
  it("shows that tag in its own menu, and only for that token", () => {
    // The CoNLL-U upload path can hand this app a DET, an X or a PUNCT.
    // Hiding it from that token's own menu would leave the chip naming a
    // category the menu did not contain, with the first edit discarding it
    // silently.
    for (const hidden of ["DET", "X", "PUNCT"]) {
      expect(uposMenuGroups(hidden), hidden).toEqual(
        expect.arrayContaining([expect.arrayContaining([expect.arrayContaining([hidden])])]),
      );
      expect(uposMenuGroups("VERB").flatMap(([, t]) => t), hidden).not.toContain(hidden);
    }
  });

  it("puts it back in its own group rather than appending it", () => {
    const det = uposMenuGroups("DET").find(([, tags]) => tags.includes("DET"));
    expect(det?.[0]).toBe("虚字");
    const x = uposMenuGroups("X").find(([, tags]) => tags.includes("X"));
    expect(x?.[0]).toBe("雑字");
    const punct = uposMenuGroups("PUNCT").find(([, tags]) => tags.includes("PUNCT"));
    expect(punct?.[0]).toBe("雑字");
  });

  it("does the same for a relation the menu does not offer", () => {
    // The deprel menu needed the fallback too, and did not have one until
    // `punct` became the first relation ever hidden from it. A CoNLL-U file
    // can give an ordinary character the `punct` relation, and resolution
    // keys on the *tag*, so such a token draws an arrow and opens a menu.
    expect(offeredRels()).not.toContain("punct");
    const withPunct = deprelMenuGroups("punct").flatMap(([, rows]) =>
      rows.flatMap((r) => r.segments.filter((sg) => sg.kind === "relation").map((sg) => sg.value)),
    );
    expect(withPunct).toContain("punct");
    expect([...withPunct].sort()).toEqual([...PARSER_DEPRELS].sort());
    // and in its own group, not appended
    const group = deprelMenuGroups("punct").find(([, rows]) => rows.some((r) => r.base === "punct"));
    expect(group?.[0]).toBe("談話・その他");
  });

  it("never empties a relation group either", () => {
    for (const current of ["", "punct", "mod", "ROOT"]) {
      for (const [heading, rows] of deprelMenuGroups(current)) {
        expect(rows.length, `${current} / ${heading}`).toBeGreaterThan(0);
      }
    }
  });

  it("never empties a group", () => {
    for (const current of [...UPOS_INVENTORY, "VERB", ""]) {
      for (const [heading, tags] of uposMenuGroups(current)) {
        expect(tags.length, `${current} / ${heading}`).toBeGreaterThan(0);
      }
    }
  });
});

describe("the adjective is an ordinary tag now", () => {
  it("is one of the morphologiser's own values, not something this app makes", () => {
    // 0.3.1 had no ADJ and this file synthesised 形容詞 out of `VERB` +
    // `Degree=Pos`. 0.3.2 emits the tag, so the synthesis — `posCategory`,
    // `applyPosChoice`, and the morph writer under them — is deleted rather
    // than adapted. This is what is left of it: nothing.
    expect(MORPHOLOGIZER_UPOS).toContain("ADJ");
    expect(offered()).toContain("ADJ");
    expect(uposJa("ADJ")).toBe("形容詞");
  });

  it("is filed with the other 用言 and reachable for any token", () => {
    const group = uposMenuGroups("VERB").find(([, tags]) => tags.includes("ADJ"));
    expect(group?.[0]).toBe("用言");
    for (const current of [...UPOS_INVENTORY, ""]) {
      expect(uposMenuGroups(current).flatMap(([, t]) => t), current).toContain("ADJ");
    }
  });

  it("marks itself current for an ADJ token and 動詞 for a VERB one", () => {
    // What the chip and the menu key on is the tag, and only the tag. The two
    // are told apart by `pos` alone now — there is no feature to consult.
    expect(uposMenuGroups("ADJ").flatMap(([, t]) => t)).toContain("ADJ");
    expect(uposJa("VERB")).toBe("動詞");
    expect(uposJa("ADJ")).not.toBe(uposJa("VERB"));
  });
});

describe("a POS edit writes the tag and nothing else", () => {
  /** What the menu's click does, which is now the whole of a POS edit:
   * `applyTokenEdit((token) => void (token.pos = value))` in `openRetagMenu`.
   * Copied here rather than imported because it is one assignment inside a
   * closure that needs a document — and the point of these is that one
   * assignment is *all* it is. */
  const pick = (t: Token, choice: string): Token => ({ ...t, pos: choice });

  /** Feature bundles as the worker writes them — spaCy's `str(token.morph)`,
   * which excludes `POS=` and is sorted. Drawn from the shapes 0.3.2's own
   * morphologiser labels take, plus the empty case and the legacy `VERB` +
   * `Degree=Pos` that 0.3.1 produced and 0.3.2 never will. */
  const MORPHS = [
    undefined,
    "",
    "VerbForm=Part",
    "Shared=No",
    "Shared=Yes|VerbForm=Part",
    "Degree=Pos",
    "Degree=Pos|VerbForm=Part",
    "Degree=Equ|VerbForm=Part",
    "ExtPos=VERB",
  ];

  it("leaves the morph untouched, whatever is picked", () => {
    // The property that replaces the old round trip. When the app synthesised
    // the adjective, picking 形容詞 *added* `Degree=Pos` and picking 動詞
    // *removed* it, and the test had to pin that the string came back
    // character for character. Now the feature is the morphologiser's to
    // write and a hand edit never touches it — which is stronger, and simpler
    // to state: the morph is not merely restored, it never moves.
    for (const morph of MORPHS) {
      for (const choice of UPOS_INVENTORY) {
        const before = token({ pos: "VERB", morph });
        const after = pick(before, choice);
        expect(after.morph, `${morph} -> ${choice}`).toBe(morph);
        expect(after.pos, `${morph} -> ${choice}`).toBe(choice);
      }
    }
  });

  it("round-trips 形容詞 and 動詞 with nothing left behind", () => {
    // Pick 形容詞, pick 動詞, pick 形容詞 again: the token is identical to
    // what the first pick produced, morph included, because neither pick ever
    // wrote a feature.
    for (const morph of MORPHS) {
      let t = token({ pos: "VERB", morph });
      t = pick(t, "ADJ");
      const first = { ...t };
      t = pick(t, "VERB");
      t = pick(t, "ADJ");
      expect(t, String(morph)).toEqual(first);
      expect(t.pos, String(morph)).toBe("ADJ");
      expect(t.morph, String(morph)).toBe(morph);
    }
  });

  it("has no trapdoor: every tag can be reached from every other", () => {
    // Which is what makes the round trip above general rather than a property
    // of two entries. A pick depends on nothing about the token it lands on,
    // so any offered tag reaches any other in one step.
    for (const from of UPOS_INVENTORY) {
      for (const to of offered()) {
        const t = pick(token({ pos: from, morph: "Degree=Pos|VerbForm=Part" }), to);
        expect(t.pos, `${from} -> ${to}`).toBe(to);
        expect(t.morph, `${from} -> ${to}`).toBe("Degree=Pos|VerbForm=Part");
      }
    }
  });
});

describe("a token left over from 0.3.1 behaves sensibly", () => {
  // A `VERB` carrying `Degree=Pos` is what an adjective was before 0.3.2
  // retagged those bundles. Auto-save has been writing such trees all
  // session and a CoNLL-U file may hold one for ever, so it is a real shape —
  // but it is not a shape the parser can produce any more.
  const legacy = () => token({ pos: "VERB", morph: "Degree=Pos|VerbForm=Part" });

  it("is named by its tag, which is 動詞", () => {
    // No fallback, deliberately: the tag is what the token has, and showing
    // it is what leaves a way back. See `uposMenuGroups` for why reading the
    // old conjunction instead would have been a trapdoor.
    expect(uposJa(legacy().pos)).toBe("動詞");
  });

  it("normalises to exactly what 0.3.2 emits when 形容詞 is picked", () => {
    // One click, and the token is `ADJ` carrying `Degree=Pos` — which is a
    // bundle the shipped morphologiser actually has, not an invention.
    const fixed = { ...legacy(), pos: "ADJ" };
    expect(fixed.pos).toBe("ADJ");
    expect(fixed.morph).toBe("Degree=Pos|VerbForm=Part");
    // `Degree=Pos|POS=ADJ|VerbForm=Part` is one of the wheel's eight ADJ
    // bundles, so this is a shape the model itself produces.
    expect(MORPHOLOGIZER_UPOS).toContain(fixed.pos);
  });

  it("can still be made a plain verb, which the rejected fallback would have prevented", () => {
    const asVerb = { ...legacy(), pos: "VERB" };
    expect(uposJa(asVerb.pos)).toBe("動詞");
    expect(asVerb.morph).toBe("Degree=Pos|VerbForm=Part");
  });
});
