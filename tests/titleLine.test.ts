import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isTitleBracket, titleReader, titleSpansOf } from "../src/parse/punctuation.ts";
import { splitProvisional } from "../src/parse/provisionalSentences.ts";
import { bareCellCount, bareItemsFor } from "../src/render/KundokuView.ts";
import { parseConllu } from "../src/parse/conlluParser.ts";
import { computeReadingOrder } from "../src/kundoku/reorderEngine.ts";
import { generateKakikudashiPiecesForTree } from "../src/kakikudashi/generator.ts";
import { findCompoundSpans, type JmdictIndex } from "../src/reading/jmdictLookup.ts";
import { createReadingResolver } from "../src/reading/readingResolver.ts";
import type { KanjidicIndex } from "../src/reading/kanjidicLookup.ts";

// ---------------------------------------------------------------------------
// 傍線: the title, in the 訓読文 — and the brackets, in the 書き下し文.
//
// The reader: **"Title brackets (《》) should be replaced with a side-underline
// (which I believe is an equivalent convention for indicating titles)."** And
// then, having seen it in both panels: **"The prose panel should have 《》, not
// the sideline!"**
//
// So the two panels differ over exactly these two characters, deliberately and
// on the reader's word — against the rule they otherwise keep, which is why
// every one of the three files involved says so and why the last two describes
// below pin *both* halves. The 訓読文 gives a title's brackets no cell and
// draws a line beside what they enclosed; the 書き下し文 writes them as the
// characters they are, like any other bracket, and takes no line.
//
// **There is no browser in this suite**, so what is checked here is what the
// two panels *plan* — which cells and which runs of prose are written, and
// which of them wear the line — exactly as `tests/bareRender.test.ts` and
// `tests/kakikudashiHang.test.ts` check the plans of their own panels. That
// the line then lands in the left-hand lane and clears the reading is
// kunten.css's and typography.css's to say, and the reader's to confirm.
// ---------------------------------------------------------------------------

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = join(ROOT, "public", "data");
const kanjidic = JSON.parse(readFileSync(join(DATA_DIR, "kanjidic-index.json"), "utf-8")) as KanjidicIndex;
const jmdict = JSON.parse(readFileSync(join(DATA_DIR, "jmdict-index.json"), "utf-8")) as JmdictIndex;
const resolve = createReadingResolver(kanjidic, jmdict);

/** Tokens as the two panels see them, from a run of characters — one token per
 * character, which is what the parser gives for this material (see the 論語
 * sample's CoNLL-U, where 《 and 》 are PUNCT tokens of their own). */
const tokensOf = (text: string) => [...text].map((ch, i) => ({ id: i + 1, text: ch }));

// ---------------------------------------------------------------------------
// The colour and the opacity, which are the quotation marks'.
//
// The reader, once the line was drawn: **"the title sideline should be the
// same colour and opacity as quotation marks."**
//
// That is a claim about two stylesheets, so it is checked in them — the same
// reader `rereadLane.test.ts`, `panelMargins.test.ts` and
// `conjClassCartouche.test.ts` use, over the files the browser reads the rules
// out of. What each assertion below pins is that the line takes the marks'
// colour **from the same declaration they do**, so that moving one moves the
// other and a divergence is a failure here rather than something nobody sees.
// ---------------------------------------------------------------------------

const SRC = join(ROOT, "src");
const kunten = readFileSync(join(SRC, "render", "kunten.css"), "utf-8");
const typography = readFileSync(join(SRC, "render", "typography.css"), "utf-8");
const print = readFileSync(join(SRC, "render", "print.css"), "utf-8");

const withoutComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");

/** Every rule in the file as a selector list and a body. Flat: a rule nested
 * in an `@media` comes back on its own, which is all these assertions need. */
function rulesOf(css: string): { selectors: string[]; body: string }[] {
  return [...withoutComments(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
    selectors: m[1].split(",").map((s) => s.trim()).filter(Boolean),
    body: m[2],
  }));
}

/** The one rule whose selector list holds exactly this selector — or, where a
 * file writes that selector more than once (print.css declares `#print-root`
 * twice, for the box and for the ink), the one whose body declares `has`. */
function ruleFor(css: string, selector: string, has?: string): { selectors: string[]; body: string } {
  const found = rulesOf(css).filter(
    (rule) => rule.selectors.includes(selector) && (has === undefined || declarations(rule.body).has(has)),
  );
  if (found.length !== 1) throw new Error(`${found.length} rules for ${selector}${has ? ` declaring ${has}` : ""}`);
  return found[0];
}

/** Every declaration in a rule body, last one winning, as the cascade has it. */
function declarations(body: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const [, name, value] of body.matchAll(/(--?[a-z-]+|[a-z-]+)\s*:\s*([^;]+);/g)) {
    out.set(name.trim(), value.replace(/\s+/g, " ").trim());
  }
  return out;
}

describe("the 傍線 is set in the quotation marks' own colour", () => {
  it("fills the 訓読文's line from the property the bracket cells take", () => {
    const bracket = declarations(ruleFor(kunten, ".punct-cell[data-punct-bracket]").body);
    const line = declarations(ruleFor(kunten, ".kanji-cell.title-line .kanji-glyph::before").body);
    // The load-bearing assertion: one value, read off both rules. Change the
    // bracket's colour and this fails until the line is changed with it.
    expect(line.get("background")).toBe(bracket.get("color"));
    // And it is a custom property rather than a literal, which is what makes
    // the agreement a shared *source* rather than two copies that happen to
    // match today.
    expect(bracket.get("color")).toMatch(/^var\(--[a-z-]+\)$/);
  });

  it("stands back wherever the punctuation stands back, at the same opacity", () => {
    // Every rule that dims a `.punct-cell` — a character selected, and a drag
    // in progress — must dim the line in the same breath. A third one added
    // without it fails here.
    const standDowns = rulesOf(kunten).filter(
      (rule) => rule.selectors.some((s) => s.endsWith(".punct-cell")) && declarations(rule.body).has("opacity"),
    );
    expect(standDowns).toHaveLength(2);
    for (const rule of standDowns) {
      const punct = rule.selectors.find((s) => s.endsWith(".punct-cell"))!;
      expect(rule.selectors).toContain(punct.replace(".punct-cell", ".title-line .kanji-glyph::before"));
      // One opacity for the whole list, so the marks and the line receive the
      // same fade — see the note in kunten.css on why the *result* is what is
      // matched, an `opacity` on a painted box and on a glyph not being the
      // same operation.
      expect(declarations(rule.body).get("opacity")).toBe("0.4");
    }
  });

  it("prints as the brackets print, by the declaration that sends them", () => {
    // print.css pins the apparatus to the text's ink on `#print-root`. The
    // line names no colour of its own, so this one declaration takes it to
    // full ink along with every 「 on the page.
    const bracket = declarations(ruleFor(kunten, ".punct-cell[data-punct-bracket]").body);
    const property = bracket.get("color")!.replace(/^var\(|\)$/g, "");
    const root = declarations(ruleFor(print, "#print-root", property).body);
    expect(root.get(property)).toBe("currentColor");
    // And, being painted as a background, it stays on the list of marks a
    // browser's economical mode must not drop.
    const exact = rulesOf(print).find((rule) => declarations(rule.body).get("print-color-adjust") === "exact")!;
    expect(exact.selectors).toContain(".title-line .kanji-glyph::before");
  });

});

describe("titleSpansOf", () => {
  it("marks the characters between the brackets, and the brackets themselves", () => {
    const { inside, marks } = titleSpansOf(tokensOf("聞《韶》。"));
    // 韶 alone carries the line; 《 and 》 are set as nothing; 聞 and 。 are
    // outside it entirely.
    expect([...inside]).toEqual([3]);
    expect([...marks].sort((a, b) => a - b)).toEqual([2, 4]);
  });

  it("reads a title of several characters as one run", () => {
    const { inside } = titleSpansOf(tokensOf("讀《春秋左氏傳》"));
    expect([...inside]).toEqual([3, 4, 5, 6, 7]);
  });

  it("counts nesting, so an inner title does not close the outer one", () => {
    const { inside, marks } = titleSpansOf(tokensOf("《甲《乙》丙》丁"));
    // 丙 is still inside the outer title although the inner one has closed;
    // 丁, after both, is not.
    expect([...inside]).toEqual([2, 4, 6]);
    expect([...marks].sort((a, b) => a - b)).toEqual([1, 3, 5, 7]);
  });

  it("does not crash on an unclosed 《, and stops at the end of the sentence", () => {
    // The whole of the unbalanced case: the run is bounded by the sentence it
    // is read over — both panels ask this per sentence — rather than by a
    // closing mark that never comes.
    const { inside, marks } = titleSpansOf(tokensOf("聞《韶"));
    expect([...inside]).toEqual([3]);
    expect([...marks]).toEqual([2]);
  });

  it("does not crash on a 》 that closes nothing", () => {
    const { inside, marks } = titleSpansOf(tokensOf("韶》甲"));
    // The depth cannot go below zero, so 甲 is outside — not inside a title
    // that was never opened.
    expect([...inside]).toEqual([]);
    expect([...marks]).toEqual([2]);
    // And a following title still reads normally.
    expect([...titleSpansOf(tokensOf("》《甲》")).inside]).toEqual([3]);
  });

  it("is the only pair it claims: every other bracket is a character like any other", () => {
    for (const ch of ["「", "」", "『", "』", "（", "）", "〈", "〉", "【", "】"]) {
      expect(isTitleBracket(ch)).toBe(false);
      // Not a mark, and — standing outside any title — not carrying a line
      // either. A 「 keeps its cell in both panels, as it always did.
      expect(titleReader()(ch)).toBe("outside");
    }
    expect(isTitleBracket("《")).toBe(true);
    expect(isTitleBracket("》")).toBe(true);
  });

  it("reads its run in source order whatever order the tokens arrive in", () => {
    // A title is legible in source order and in no other, so the walk sorts by
    // id rather than trusting the list it is handed. Nothing in the app passes
    // tokens out of order today; this is what makes that not matter.
    const shuffled = [...tokensOf("聞《韶》")].reverse();
    expect([...titleSpansOf(shuffled).inside]).toEqual([3]);
  });
});

describe("titleReader", () => {
  it("answers per character, and the marks are neither inside nor outside", () => {
    const read = titleReader();
    expect([..."甲《乙》丙"].map(read)).toEqual(["outside", "mark", "inside", "mark", "outside"]);
  });
});

describe("the 訓読文 panel, before the parse", () => {
  it("gives a title's brackets no cell, and the line to what they enclosed", () => {
    const [region] = splitProvisional("子在齊聞《韶》。");
    const cells = bareItemsFor(region).filter((i) => i.kind === "char" || i.kind === "punct");
    // No 《 and no 》 anywhere in the column — and no empty cell standing in
    // for one, which would take a place in the line just as the glyph did.
    expect(cells.map((i) => i.text)).toEqual([..."子在齊聞韶", "。"]);
    // 韶 carries the line, and nothing else does.
    expect(cells.filter((i) => i.title).map((i) => i.text)).toEqual(["韶"]);
  });

  it("keeps every other bracket in a cell of its own", () => {
    // The companion to `bareRender.test.ts`'s "keeps a bracket as the bracket
    // it is": 《》 are the one pair this does not hold for.
    const [region] = splitProvisional("「甲」。");
    const cells = bareItemsFor(region).filter((i) => i.kind === "char" || i.kind === "punct");
    expect(cells.map((i) => i.text)).toEqual(["「", "甲", "」", "。"]);
    expect(cells.some((i) => i.title)).toBe(false);
  });

  it("counts the cells it draws, which is two short of the region's characters", () => {
    // The reveal advances through cells and the parse's own accounts are
    // settled in characters, so the two counts have to be taken separately
    // once a title's brackets have cells in neither — see `bareCellCount`. A
    // frontier fed the character count would never reach the end of this text.
    const [region] = splitProvisional("子在齊聞《韶》。");
    expect(region.length).toBe(8);
    expect(bareCellCount(region)).toBe(6);
    // And they are the same number for a text with no title in it.
    const [plain] = splitProvisional("子在齊聞韶。");
    expect(bareCellCount(plain)).toBe(plain.length);
  });

  it("leaves a source indent standing where a bracket is dropped from it", () => {
    const [, second] = splitProvisional("甲。\n\n《乙》。");
    // The break and the paragraph's indent are the bracket's own layout, and
    // they survive it being set as nothing.
    expect(bareItemsFor(second).slice(0, 2)).toEqual([{ kind: "break" }, { kind: "indent" }]);
    expect(bareItemsFor(second).filter((i) => i.kind === "char").map((i) => i.text)).toEqual(["乙"]);
  });
});

describe("the 書き下し文 panel", () => {
  const tree = parseConllu(readFileSync(join(DATA_DIR, "samples", "rongo-gakuji.conllu"), "utf-8"));
  const withTitle = tree.sentences.filter((s) => s.tokens.some((t) => t.text === "《"));
  const pieces = generateKakikudashiPiecesForTree(
    tree,
    (sentence) => computeReadingOrder(sentence, findCompoundSpans(sentence, { kanjidic, jmdict })),
    resolve,
  );

  /** The characters the panel sets for one sentence, assembled from its pieces
   * the way `renderKakikudashiView` assembles them — a piece's own text and
   * its case particle, in the order the pieces come in, with the source's line
   * structure left out. There is no browser here to read the panel off; this
   * is the same string, one step before the spans. */
  const proseOf = (index: number): string =>
    pieces[index]
      .filter((piece) => piece.kind !== "layout")
      .map((piece) => piece.text + (piece.caseParticle ?? ""))
      .join("");

  it("finds the titles the shipped sample actually carries", () => {
    // 《詩》 twice in 學而第一 — the fixture this is checked against, so that a
    // sample rebuilt without them would say so here rather than leaving the
    // assertions below vacuous.
    expect(withTitle).toHaveLength(2);
  });

  it("writes 《 and 》 as characters of the prose, one for each the source has", () => {
    // The reader's ruling: the brackets belong to the writing here, and only
    // the 訓読文 trades them for a line. Every one the source wrote is set.
    for (const sentence of withTitle) {
      const index = tree.sentences.indexOf(sentence);
      const source = sentence.tokens.map((t) => t.text).join("");
      const prose = proseOf(index);
      for (const mark of ["《", "》"]) {
        expect([...prose].filter((ch) => ch === mark)).toHaveLength(
          [...source].filter((ch) => ch === mark).length,
        );
      }
    }
  });

  it("sets the pair round its title, wherever reading order puts the title", () => {
    // 子貢曰：「《詩》云… comes out 子貢曰く、「《詩》云ふ、… — the brackets on
    // either side of the word, exactly as the source has them. Reading order
    // leaves that one alone, so it says nothing on its own about where a
    // bracket goes.
    const quoting = withTitle.find((s) => s.tokens.some((t) => t.text === "子貢"))!;
    expect(proseOf(tree.sentences.indexOf(quoting))).toContain("《詩》");

    // **The other sentence is the one that says it.** 始可與言《詩》已矣 carries
    // 詩 off to its verb — it is 言's `comp:obj` and inverts in front of it —
    // and the two marks used to stay behind together, printing …詩を言ふ…《》、.
    //
    // The reader's ruling: *"Title brackets should move with their content,
    // obviously."* `placeMarks` in `reorderEngine.ts` now anchors them to the
    // title instead of to a source position — 《 before the first-read token
    // inside it and 》 after the last — and this is the sentence that
    // distinguishes the two rules. See `titlePairsOf` there.
    const other = withTitle.find((s) => s !== quoting)!;
    const prose = proseOf(tree.sentences.indexOf(other));
    expect(prose).not.toContain("《》");
    expect(prose).toMatch(/《詩[^》]*》/u);
    // The を is inside the pair — 《詩を》 — because a case particle is emitted
    // as part of its own token's piece and the 》 is anchored to that token.
    // Recorded rather than asserted as right: the received text would write
    // 《詩》を, and moving the bracket inside a token's own cell is a question
    // for the generator rather than for reading order.
    expect(prose).toContain("《詩を》");
  });
});

describe("the two panels' rulings, held apart", () => {
  it("gives the 訓読文 the line and the 書き下し文 the brackets", () => {
    // The asymmetry itself, as the two stylesheets state it. It is deliberate
    // (see the notes in punctuation.ts, KundokuView.ts and KakikudashiView.ts),
    // and this is what would fail if someone reconciled the panels in either
    // direction without reading them.
    expect(kunten).toContain(".kanji-cell.title-line .kanji-glyph::before");
    // Nothing in the prose panel's stylesheet marks a title at all — no rule,
    // no `text-decoration`, no class.
    expect(withoutComments(typography)).not.toContain("title-line");
  });
});
