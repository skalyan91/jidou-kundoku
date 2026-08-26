import { describe, expect, it } from "vitest";
import { candidateReadings, type KanjidicIndex } from "../src/reading/kanjidicLookup.ts";

/** 中 is the case `pickKun`'s own doc calls out: it carries both an
 * inflecting kun'yomi (あた.る "to hit") and bare nominal ones (なか/うち
 * "middle/inside"), so it separates the two POS families cleanly. */
const index: KanjidicIndex = {
  中: { on: ["チュウ"], kun: ["なか", "うち", "あた.る"], meanings: ["in", "middle"] },
  藍: { on: ["ラン"], kun: ["あい"], meanings: ["indigo"] },
};

const readings = (char: string, pos?: string) =>
  candidateReadings(index, char, pos).map((c) => c.reading + (c.okurigana ? `.${c.okurigana}` : ""));

describe("candidateReadings", () => {
  it("offers only inflecting kun'yomi to a verb", () => {
    const out = readings("中", "VERB");
    expect(out).toContain("あた.る");
    expect(out).not.toContain("なか");
    expect(out).not.toContain("うち");
  });

  it("offers only bare kun'yomi to a noun", () => {
    const out = readings("中", "NOUN");
    expect(out).toContain("なか");
    expect(out).toContain("うち");
    expect(out).not.toContain("あた.る");
  });

  it("offers on'yomi to both, since an uninflected stem fits either", () => {
    expect(readings("中", "VERB")).toContain("ちゅう");
    expect(readings("中", "NOUN")).toContain("ちゅう");
  });

  it("converts on'yomi out of kanjidic's katakana", () => {
    expect(readings("藍", "NOUN")).toContain("らん");
  });

  it("leads with on'yomi, whatever the part of speech", () => {
    expect(readings("藍", "PROPN")[0]).toBe("らん");
    expect(readings("藍", "NOUN")[0]).toBe("らん");
    expect(readings("中", "VERB")[0]).toBe("ちゅう");
  });

  it("withholds nothing from the mixed tags pickKun declines to guess for", () => {
    const out = readings("中", "PART");
    expect(out).toEqual(expect.arrayContaining(["なか", "うち", "あた.る", "ちゅう"]));
  });

  it("marks which series each candidate came from", () => {
    const kinds = candidateReadings(index, "中", "NOUN").map((c) => c.kind);
    expect(kinds).toEqual(["on", "kun", "kun"]);
  });

  it("returns nothing for a character the index doesn't have", () => {
    expect(candidateReadings(index, "龘", "NOUN")).toEqual([]);
  });

  it("de-duplicates a reading listed in both series", () => {
    const dup: KanjidicIndex = { 己: { on: ["コ"], kun: ["こ"], meanings: ["self"] } };
    expect(candidateReadings(dup, "己", "NOUN")).toHaveLength(1);
  });
});

describe("candidateReadings prefix/suffix notation", () => {
  const index: KanjidicIndex = {
    木: { on: ["ボク"], kun: ["き", "こ-"], meanings: ["tree"] },
    直: { on: ["チョク"], kun: ["なお.す", "-なお.す"], meanings: ["straight"] },
  };

  it("strips kanjidic's prefix/suffix hyphen from the reading", () => {
    const out = candidateReadings(index, "直", "VERB").map((c) => c.reading);
    expect(out).toContain("なお");
    expect(out.some((r) => r.includes("-"))).toBe(false);
  });

  it("folds a hyphenated form into the bare one already listed", () => {
    expect(candidateReadings(index, "木", "NOUN").map((c) => c.reading)).toEqual(["ぼく", "き", "こ"]);
    expect(candidateReadings(index, "直", "VERB")).toHaveLength(2); // なお.す + ちょく
  });
});

describe("candidateReadings in historical kana", () => {
  const index: KanjidicIndex = {
    直: { on: ["チョク"], kun: ["なお.す", "なお.る"], meanings: ["straight"] },
    繩: { on: ["ジョウ"], kun: ["なわ"], meanings: ["rope"] },
  };
  // Keyed by kanji spelling *and* modern reading, per HistoricalKanaIndex.
  const historical = { 直: { なお: "なほ", ちょく: "ちよく" }, 繩: { なわ: "なは", じょう: "ぜう" } };

  it("puts kun'yomi into historical spelling", () => {
    expect(candidateReadings(index, "繩", "NOUN", historical).map((c) => c.reading)).toContain("なは");
  });

  it("puts on'yomi into historical spelling too", () => {
    expect(candidateReadings(index, "繩", "NOUN", historical).map((c) => c.reading)).toContain("ぜう");
  });

  it("leaves the okurigana alone, substituting only the reading", () => {
    const [nahosu] = candidateReadings(index, "直", "VERB", historical).filter((c) => c.kind === "kun");
    expect(nahosu.reading).toBe("なほ");
    expect(nahosu.okurigana).toBe("す");
  });

  it("collapses two modern readings that share one historical spelling", () => {
    // なお.す and なお.る both map to なほ, but keep distinct endings, so
    // they stay two entries rather than being folded together.
    const kun = candidateReadings(index, "直", "VERB", historical).filter((c) => c.kind === "kun");
    expect(kun.map((c) => `${c.reading}.${c.okurigana}`)).toEqual(["なほ.す", "なほ.る"]);
  });

  it("passes readings through unchanged with no index", () => {
    expect(candidateReadings(index, "繩", "NOUN").map((c) => c.reading)).toEqual(["じょう", "なわ"]);
  });
});
