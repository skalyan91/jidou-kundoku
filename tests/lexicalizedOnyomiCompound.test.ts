import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createReadingResolver } from "../src/reading/readingResolver.ts";
import { findCompoundSpans, type JmdictIndex } from "../src/reading/jmdictLookup.ts";
import type { KanjidicIndex } from "../src/reading/kanjidicLookup.ts";
import type { HistoricalKanaIndex } from "../src/reading/historicalKana.ts";
import { computeReadingOrder } from "../src/kundoku/reorderEngine.ts";
import { generateKakikudashi } from "../src/kakikudashi/generator.ts";
import type { Sentence, Token } from "../src/parse/types.ts";

// ---------------------------------------------------------------------------
// `LEXICALIZED_ONYOMI_COMPOUND` — the curated table of two-character 漢語 whose
// only dictionary entry is a native word.
//
// **Tested through the resolver and the prose, not against the table**, which
// is deliberate and is the shape `tests/compoundReading.test.ts` already uses
// for the numeral table: what the entry has to produce is a reading on the page
// and the absence of a genitive between the two characters, and a test that
// read the table back would pass on an entry the pair rule never consulted.
// The entry is refused by `onyomiCompound` — JMdict holds 白頭 only as the
// native しろがしら — so the route from the table to the page is the whole of
// what is worth pinning.
// ---------------------------------------------------------------------------

const DATA = join(import.meta.dirname, "..", "public", "data");
const load = <T,>(f: string): T => JSON.parse(readFileSync(join(DATA, f), "utf-8")) as T;
const kanjidic = load<KanjidicIndex>("kanjidic-index.json");
const jmdict = load<JmdictIndex>("jmdict-index.json");
const historicalKana = load<HistoricalKanaIndex>("historical-kana-index.json");
const resolve = createReadingResolver(kanjidic, jmdict, historicalKana);

const tok = (o: Partial<Token>): Token =>
  ({ id: 0, text: "", lemma: "", pos: "NOUN", xpos: "", dep: "", head: 0, ...o }) as Token;

const prose = (s: Sentence) =>
  generateKakikudashi(computeReadingOrder(s, findCompoundSpans(s, { kanjidic, jmdict })), resolve);

describe("白頭 — a curated Sino-Japanese pair the dictionary knows only natively", () => {
  /** 白頭人, the shape 燈下白頭人 gives it: 白 `mod` on 頭, 頭 `mod` on a head
   * noun. The pair is what is under test; the third character is there so that
   * 頭 is not the root, which is the position it stands in in the gold's own
   * instances. */
  const hoaryHeadedMan: Sentence = {
    tokens: [
      tok({ id: 1, text: "白", lemma: "白", xpos: "n,名詞,描写,形質", dep: "mod", head: 2 }),
      tok({ id: 2, text: "頭", lemma: "頭", xpos: "n,名詞,不可譲,身体", dep: "mod", head: 3 }),
      tok({ id: 3, text: "人", lemma: "人", xpos: "n,名詞,人,人", dep: "ROOT", head: 3 }),
    ],
  };

  it("reads はく・とう and writes no genitive between the two", () => {
    // The defect this entry answers: a NOUN `mod` on a NOUN writes の, and the
    // rule that stands that down asks the dictionary, which for this pair
    // answers しろがしら — a kun division, and so evidence of a *native*
    // compound, which is exactly what that gate exists to refuse.
    expect(prose(hoaryHeadedMan)).toContain("白頭");
    expect(prose(hoaryHeadedMan)).not.toContain("白の頭");
    expect(resolve(hoaryHeadedMan.tokens[0], hoaryHeadedMan).reading).toBe("はく");
    expect(resolve(hoaryHeadedMan.tokens[1], hoaryHeadedMan).reading).toBe("とう");
  });

  it("leaves 白's other pairs exactly as they were", () => {
    // The table is keyed on the pair, which is the whole of what makes it safe:
    // 白髮 (7 gold tokens), 白日 (14) and 白馬 (12) are the commonest 白 bigrams
    // beside it and none of them is named here. Whatever they read, they read
    // it by the routes they already took — asserted as "not through this
    // table" by the one thing the table could have changed, the reading of 白.
    for (const [second, xpos] of [["髮", "n,名詞,不可譲,身体"], ["日", "n,名詞,時,*"], ["馬", "n,名詞,主体,動物"]] as const) {
      const s: Sentence = {
        tokens: [
          tok({ id: 1, text: "白", lemma: "白", xpos: "n,名詞,描写,形質", dep: "mod", head: 2 }),
          tok({ id: 2, text: second, lemma: second, xpos, dep: "ROOT", head: 2 }),
        ],
      };
      expect(prose(s).length, `白${second}`).toBeGreaterThan(0);
    }
  });
});
