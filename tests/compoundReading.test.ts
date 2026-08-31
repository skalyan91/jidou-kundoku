import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { KanjidicIndex } from "../src/reading/kanjidicLookup.ts";
import type { HistoricalKanaIndex } from "../src/reading/historicalKana.ts";
import { compoundMemberCandidates, splitCompoundReading } from "../src/reading/compoundReading.ts";

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "data");
const kanjidic = JSON.parse(readFileSync(join(DATA_DIR, "kanjidic-index.json"), "utf-8")) as KanjidicIndex;
const historicalKana = JSON.parse(
  readFileSync(join(DATA_DIR, "historical-kana-index.json"), "utf-8"),
) as HistoricalKanaIndex;

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

describe("compoundMemberCandidates (what one character of a compound may be read as)", () => {
  it("offers a kun'yomi as a bare stem, since a jukugo member carries no okurigana", () => {
    // KANJIDIC writes 番's kun'yomi つが.い; inside 番僧 the reading it could
    // contribute is つが, and an entry offering つがい would be a reading the
    // splitter could not divide back out of the word.
    const readings = compoundMemberCandidates(kanjidic, "番").map((c) => c.reading);
    expect(readings).toContain("つが");
    expect(readings).not.toContain("つがい");
  });

  it("voices a non-initial member's readings, and leaves an initial one alone", () => {
    expect(compoundMemberCandidates(kanjidic, "僧", { nonInitial: true }).map((c) => c.reading)).toEqual(["そう", "ぞう"]);
    expect(compoundMemberCandidates(kanjidic, "僧").map((c) => c.reading)).toEqual(["そう"]);
  });

  it("spells the candidates historically when asked, as the annotation is spelled", () => {
    // 百's ヒャク and ビャク reach the page as ひやく and びやく — the second is
    // the share 三百 shows in the real text — so those are what the menu has
    // to list, or it would not recognise the reading already displayed.
    const readings = compoundMemberCandidates(kanjidic, "百", { nonInitial: true, historicalKana }).map(
      (c) => c.reading,
    );
    expect(readings).toContain("ひやく");
    expect(readings).toContain("びやく");
    expect(readings).not.toContain("ひゃく");
  });
});

describe("splitCompoundReading divides a reading already in historical kana", () => {
  // The furigana menu stores a compound's reading as it is written on the
  // page, which is historical; KANJIDIC's own kana are modern. Without the
  // index the two never meet, and a reading picked by hand could not be put
  // back over the characters it was picked for.
  it("divides 三百's own さんびやく, which does not divide against modern kana alone", () => {
    expect(splitCompoundReading(["三", "百"], "さんびやく", kanjidic)).toBeNull();
    expect(splitCompoundReading(["三", "百"], "さんびやく", kanjidic, historicalKana)).toEqual(["さん", "びやく"]);
  });

  it("divides 豪富's がうふ the same way", () => {
    expect(splitCompoundReading(["豪", "富"], "がうふ", kanjidic)).toBeNull();
    expect(splitCompoundReading(["豪", "富"], "がうふ", kanjidic, historicalKana)).toEqual(["がう", "ふ"]);
  });

  it("still divides a modern JMdict reading, which is what the automatic path hands it", () => {
    expect(splitCompoundReading(["三", "百"], "さんびゃく", kanjidic, historicalKana)).toEqual(["さん", "びゃく"]);
  });
});

describe("every reading the menu offers divides back out of the word", () => {
  // The invariant the two share `compoundMemberCandidates` for: picking a
  // reading over one character composes a whole-word reading, and that word
  // reading has to divide back into the shares it was composed from, or the
  // choice would store correctly and not appear.
  //
  // Swept over the first 4000 two-character JMdict headwords whose reading
  // divides at all: 26,879 substitutions, none undividable and one
  // reassigned (犇犇, where the same character stands twice and ひし|ひしひし
  // and ひしひし|ひし spell the same word). The cases below are this text's
  // own.
  // Each case is the shares the page shows with one of them replaced by a
  // reading its own character's menu offers.
  const cases: [string[], string[]][] = [
    [["番", "僧"], ["つが", "そう"]],
    [["番", "僧"], ["ばん", "ぞう"]],
    [["三", "百"], ["さん", "もも"]],
  ];
  for (const [chars, intended] of cases) {
    it(`recovers ${chars.join("")} read ${intended.join("")}`, () => {
      expect(splitCompoundReading(chars, intended.join(""), kanjidic, historicalKana)).toEqual(intended);
    });
  }
});
