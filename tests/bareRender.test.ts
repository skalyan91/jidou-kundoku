import { describe, expect, it } from "vitest";
import { bareItemsFor, revealDelays } from "../src/render/KundokuView.ts";
import { splitProvisional } from "../src/parse/provisionalSentences.ts";

// ---------------------------------------------------------------------------
// Stage one: the text drawn out of its own characters, before the parse.
//
// There is no browser in this suite, so what is checked here is the *plan* —
// which cells the bare render puts in the column and in what order — rather
// than the markup it makes of them. That is the half that has to agree with
// the annotated render, and the agreement is the whole requirement: the
// characters a reader is looking at when the readings arrive must still be
// under their eye afterwards. See the note at the head of the section in
// `KundokuView.ts` for why the *placement* then follows from the plan (a fixed
// column pitch, a fixed advance, and every annotation out of flow).

const cellsOf = (items: ReturnType<typeof bareItemsFor>) => items.filter((i) => i.kind === "char" || i.kind === "punct");

describe("bareItemsFor", () => {
  it("writes one cell per character of the region, in source order", () => {
    const [region] = splitProvisional("學而時習之。");
    expect(cellsOf(bareItemsFor(region)).map((i) => i.text)).toEqual(["學", "而", "時", "習", "之", "。"]);
  });

  it("counts characters and not code units", () => {
    // Outside the BMP: one character, one cell — as `renderSentence`'s own
    // `[...token.text]` would spread it.
    const [region] = splitProvisional("𠀀𠀁。");
    expect(cellsOf(bareItemsFor(region))).toHaveLength(3);
  });

  it("puts punctuation in a punct cell and everything else in a plain one", () => {
    const [region] = splitProvisional("子曰：「學。");
    expect(bareItemsFor(region).map((i) => i.kind)).toEqual(["char", "char", "punct", "punct", "char", "punct"]);
  });

  it("writes each mark the way this panel writes marks, not the way the source did", () => {
    // ， is a comma however the parser segments on it, and ？ is a full stop:
    // `japanesePunct`'s rule, and the point of it being one rule for both
    // panels.
    const regions = splitProvisional("學而時習之，不亦說乎？");
    const written = regions.flatMap((r) => cellsOf(bareItemsFor(r)).map((i) => i.text)).join("");
    expect(written).toBe("學而時習之、不亦說乎。");
  });

  it("keeps a bracket as the bracket it is", () => {
    const [region] = splitProvisional("「甲」。");
    expect(cellsOf(bareItemsFor(region)).map((i) => i.text)).toEqual(["「", "甲", "」", "。"]);
  });

  it("starts a new column where the source started a new line", () => {
    const [, second] = splitProvisional("春眠不覺曉\n處處聞啼鳥");
    expect(bareItemsFor(second)[0]).toEqual({ kind: "break" });
  });

  it("indents a new paragraph by one cell where the source indented it by none", () => {
    const [, second] = splitProvisional("甲。\n\n乙。");
    expect(bareItemsFor(second).slice(0, 2)).toEqual([{ kind: "break" }, { kind: "indent" }]);
  });

  it("takes the source's own indent where there is one, rather than adding to it", () => {
    const [, second] = splitProvisional("甲。\n\n   乙。");
    const items = bareItemsFor(second);
    expect(items.filter((i) => i.kind === "indent")).toHaveLength(3);
  });

  it("indents without breaking a column where a space carries no newline", () => {
    const [, second] = splitProvisional("甲。 乙。");
    expect(bareItemsFor(second)[0]).toEqual({ kind: "indent" });
    expect(bareItemsFor(second).some((i) => i.kind === "break")).toBe(false);
  });

  it("turns a space inside a region into a blank cell where it stands", () => {
    const [region] = splitProvisional("甲 乙。");
    expect(bareItemsFor(region).map((i) => i.kind)).toEqual(["char", "indent", "char", "punct"]);
  });

  it("draws the document's whole text, once, in order", () => {
    const source = "子曰：「學而時習之，不亦說乎？」\n有朋自遠方來。\n\n人不知而不慍、不亦君子乎。";
    const drawn = splitProvisional(source)
      .flatMap((r) => cellsOf(bareItemsFor(r)))
      .map((i) => i.text)
      .join("");
    // Every non-whitespace character, in source order, with only the marks
    // rewritten — nothing dropped, nothing doubled, nothing moved.
    expect([...drawn].length).toBe([...source.replace(/\s+/g, "")].length);
    expect(drawn.replace(/[。、]/g, "")).toBe(source.replace(/\s+/g, "").replace(/[。、，？！：；]/g, ""));
  });
});

describe("revealDelays", () => {
  it("starts the first sentence of a wave at once", () => {
    expect(revealDelays(4)[0]).toBe(0);
  });

  it("spreads a wave's starts over one settling interval, however many there are", () => {
    for (const n of [1, 2, 5, 17, 64]) {
      const delays = revealDelays(n);
      expect(delays).toHaveLength(n);
      // Strictly increasing — the sweep runs down the page in reading order.
      for (let i = 1; i < n; i++) expect(delays[i]).toBeGreaterThan(delays[i - 1]);
      // And the last one has begun before the first one has finished, so the
      // wave reads as one gesture rather than as a queue.
      expect(delays[n - 1]).toBeLessThan(260);
    }
  });

  it("takes no longer over sixty sentences than over two", () => {
    expect(revealDelays(64).at(-1)!).toBeLessThan(revealDelays(2).at(-1)! + 260);
  });

  it("returns nothing for a wave with nothing in it", () => {
    expect(revealDelays(0)).toEqual([]);
  });
});
