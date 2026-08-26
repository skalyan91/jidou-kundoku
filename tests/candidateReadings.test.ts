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

  it("leads with on'yomi for a proper noun, matching lookupKanji", () => {
    expect(readings("藍", "PROPN")[0]).toBe("らん");
  });

  it("withholds nothing from the mixed tags pickKun declines to guess for", () => {
    const out = readings("中", "PART");
    expect(out).toEqual(expect.arrayContaining(["なか", "うち", "あた.る", "ちゅう"]));
  });

  it("marks which series each candidate came from", () => {
    const kinds = candidateReadings(index, "中", "NOUN").map((c) => c.kind);
    expect(kinds).toEqual(["kun", "kun", "on"]);
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
    expect(candidateReadings(index, "木", "NOUN").map((c) => c.reading)).toEqual(["き", "こ", "ぼく"]);
    expect(candidateReadings(index, "直", "VERB")).toHaveLength(2); // なお.す + ちょく
  });
});
