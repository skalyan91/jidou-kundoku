import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { KanjidicIndex } from "../src/reading/kanjidicLookup.ts";
import { splitCompoundReading } from "../src/reading/compoundReading.ts";

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

