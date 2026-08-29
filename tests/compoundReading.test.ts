import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { KanjidicIndex } from "../src/reading/kanjidicLookup.ts";
import { sequentialVoicing, splitCompoundReading } from "../src/reading/compoundReading.ts";

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "data");
const kanjidic = JSON.parse(readFileSync(join(DATA_DIR, "kanjidic-index.json"), "utf-8")) as KanjidicIndex;

describe("splitCompoundReading (real KANJIDIC2 data)", () => {
  it("splits 君子(くんし) into 君=くん (on'yomi), 子=し (on'yomi)", () => {
    expect(splitCompoundReading(["君", "子"], "くんし", kanjidic)).toEqual(["くん", "し"]);
  });

  it("splits 大事(だいじ) into 大=だい, 事=じ (both on'yomi)", () => {
    expect(splitCompoundReading(["大", "事"], "だいじ", kanjidic)).toEqual(["だい", "じ"]);
  });

  it("splits 花火(はなび) into 花=はな (kun'yomi), 火=び (rendaku-voiced kun'yomi ひ)", () => {
    expect(splitCompoundReading(["花", "火"], "はなび", kanjidic)).toEqual(["はな", "び"]);
  });

  it("prefers a longer candidate over a shorter one that would leave the rest unmatched", () => {
    // 君 alone: on くん(2 mora) is correct here; a hypothetical greedy
    // shortest-first matcher could grab a 1-character candidate and fail
    // to complete the second character's match.
    const result = splitCompoundReading(["君", "子"], "くんし", kanjidic);
    expect(result?.[0]).toBe("くん");
  });

  it("returns null when the combined reading can't be assigned across the characters at all", () => {
    expect(splitCompoundReading(["君", "子"], "ぜんぜん", kanjidic)).toBeNull();
  });

  it("returns null for a character absent from KANJIDIC", () => {
    expect(splitCompoundReading(["君", "＃"], "くんし", kanjidic)).toBeNull();
  });
});

describe("sequentialVoicing (連濁)", () => {
  it("voices the initial voiceless obstruent of each row", () => {
    expect(sequentialVoicing("かみ")).toBe("がみ");
    expect(sequentialVoicing("そら")).toBe("ぞら");
    expect(sequentialVoicing("とり")).toBe("どり");
    expect(sequentialVoicing("はやし")).toBe("ばやし");
  });

  it("voices は to ば, which is why the reading must already be historical", () => {
    // A modern わ has no ば to become — the substitution has to have
    // happened before this runs.
    expect(sequentialVoicing("はやし")).toBe("ばやし");
    expect(sequentialVoicing("わやし")).toBeNull();
  });

  it("declines under Lyman's Law — no rendaku past a voiced obstruent", () => {
    expect(sequentialVoicing("かぜ")).toBeNull(); // 山風 is やまかぜ, never *やまがぜ
    expect(sequentialVoicing("かがみ")).toBeNull();
  });

  it("counts only obstruents as blockers, not nasals or liquids", () => {
    // かみ (紙) has a nasal and a liquid-free tail: 手紙 is てがみ.
    expect(sequentialVoicing("かみ")).toBe("がみ");
    expect(sequentialVoicing("から")).toBe("がら");
  });

  it("has nothing to voice in a reading that begins with a vowel, nasal or liquid", () => {
    expect(sequentialVoicing("あき")).toBeNull();
    expect(sequentialVoicing("みち")).toBeNull();
    expect(sequentialVoicing("")).toBeNull();
  });
});
