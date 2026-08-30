import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { candidateReadings, lookupKanji, type KanjidicIndex } from "../src/reading/kanjidicLookup.ts";
import { fullSizeKana } from "../src/reading/historicalKana.ts";
import type { JmdictIndex } from "../src/reading/jmdictLookup.ts";

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

describe("fullSizeKana", () => {
  // The shared rule, tested on its own because two paths run it: the kanjidic
  // lookups below, and `lexiconFurigana` in KundokuView.ts for the 39
  // VERB_LEXICON entries whose extraction found no classical table and fell
  // back on a modern reading.
  it("writes 促音 and 拗音 at full size", () => {
    expect(fullSizeKana("のっと")).toBe("のつと");
    expect(fullSizeKana("おっしゃ")).toBe("おつしや");
    expect(fullSizeKana("しょく")).toBe("しよく");
    expect(fullSizeKana("ひしゃく")).toBe("ひしやく");
  });

  it("leaves a fused long vowel alone", () => {
    // ょう/ゅう are not 拗音 but a long vowel, and けう/きやう/きよう all give
    // きょう — which one a word had is not something the glyph size settles.
    expect(fullSizeKana("ひょう")).toBe("ひょう");
    expect(fullSizeKana("じゅう")).toBe("じゅう");
    expect(fullSizeKana("どじょう")).toBe("どじょう");
  });

  it("leaves a reading with nothing to fold untouched", () => {
    expect(fullSizeKana("したが")).toBe("したが");
    expect(fullSizeKana("")).toBe("");
  });
});

describe("a kun'yomi the index does not attest is still written full-size", () => {
  // 歴史的仮名遣い has no small kana: 促音 is a full-size つ and 拗音 a
  // full-size や/ゆ/よ. Folding those is the one correction made without
  // attestation, because it is the only one that decides nothing — the two
  // glyph sizes spell the same syllable.
  const index: KanjidicIndex = {
    則: { on: ["ソク"], kun: ["のっと.る", "のり", "すなわち"], meanings: ["rule"] },
    喋: { on: ["チョウ"], kun: ["しゃべ.る"], meanings: ["chatter"] },
    鰍: { on: ["シュウ"], kun: ["かじか", "どじょう"], meanings: ["loach"] },
    貴: { on: ["キ"], kun: ["たっと.い"], meanings: ["precious"] },
  };
  const historical = { 則: { すなわち: "すなはち" }, 貴: { たっと: "たふと" } };
  const kun = (char: string) =>
    candidateReadings(index, char, undefined, historical)
      .filter((c) => c.kind === "kun")
      .map((c) => c.reading + (c.okurigana ? `.${c.okurigana}` : ""));

  it("writes 促音 as a full-size つ", () => {
    expect(kun("則")).toEqual(["のつと.る", "のり", "すなはち"]);
  });

  it("writes 拗音 full-size", () => {
    expect(kun("喋")).toEqual(["しやべ.る"]);
  });

  it("leaves a small kana before う alone, which is a long vowel and not 拗音", () => {
    // どじょう is historically どぢやう, and けう/きやう/きよう all give きょう —
    // which spelling a fused long vowel had is a fact about the word, so an
    // unattested one is an abstention rather than a mechanical fold.
    expect(kun("鰍")).toEqual(["かじか", "どじょう"]);
  });

  it("leaves an on'yomi alone, small kana and all", () => {
    // On'yomi are long vowels almost throughout, and they have their own
    // source — see `derive-onyomi-kana.py`, which abstains rather than guess.
    expect(candidateReadings(index, "鰍", undefined, historical).filter((c) => c.kind === "on")[0].reading).toBe("しゅう");
  });

  it("prefers what the index attests to the fold", () => {
    // 貴's たっと is たふと, not the たつと the fold alone would produce: the
    // modern reading is a contraction of a longer historical spelling, which
    // only attestation can know.
    expect(kun("貴")).toEqual(["たふと.い"]);
  });

  it("gives lookupKanji the same answer it gives the menu", () => {
    // The menu's job is to name the reading on the page and offer the
    // alternatives to it, so the two paths have to agree character for
    // character or the current reading would never match one of its own
    // entries.
    expect(lookupKanji(index, "則", "VERB", undefined, historical)).toMatchObject({ reading: "のつと", okurigana: "る" });
    expect(lookupKanji(index, "貴", "VERB", undefined, historical)).toMatchObject({ reading: "たふと" });
  });

  it("hands back kanjidic's own modern kana when no index is passed", () => {
    // `rendakuHeadReading` omits the index on purpose — it compares a reading
    // against JMdict's spelling of the compound, which is modern kana — so
    // the argument has to mean "in this app's orthography" rather than only
    // "correct what is attested".
    expect(lookupKanji(index, "則", "VERB")).toMatchObject({ reading: "のっと" });
    expect(candidateReadings(index, "喋").map((c) => c.reading)).toContain("しゃべ");
  });
});

describe("lookupKanji for a nominal with no bare kun", () => {
  const index: KanjidicIndex = {
    // 利's only kun is the verb き.く "to be effective"; as a noun it is り.
    利: { on: ["リ"], kun: ["き.く"], meanings: ["profit"] },
    山: { on: ["サン"], kun: ["やま"], meanings: ["mountain"] },
  };

  it("falls through to the on'yomi rather than reading it as the verb", () => {
    expect(lookupKanji(index, "利", "NOUN")).toMatchObject({ reading: "り" });
    expect(lookupKanji(index, "利", "NOUN")?.okurigana).toBeUndefined();
  });

  it("still prefers a bare kun where the entry has one", () => {
    expect(lookupKanji(index, "山", "NOUN")).toMatchObject({ reading: "やま" });
  });

  it("leaves a verb reading the dotted kun", () => {
    expect(lookupKanji(index, "利", "VERB")).toMatchObject({ reading: "き", okurigana: "く" });
  });
});

describe("lookupKanji strips kanjidic's prefix/suffix hyphen", () => {
  // 毎's only inflecting kun'yomi is the suffix-marked "-ごと.に", and this
  // path used to write the hyphen into the ruby as part of the reading
  // while `candidateReadings` stripped it — the two disagreed about the
  // same character.
  const index: KanjidicIndex = { 毎: { on: ["マイ"], kun: ["ごと", "-ごと.に"], meanings: ["every"] } };

  it("reads -ごと.に as ごと + に, with no hyphen anywhere", () => {
    expect(lookupKanji(index, "毎", "VERB")).toMatchObject({ reading: "ごと", okurigana: "に" });
  });
});

describe("lookupKanji ranked by transitivity", () => {
  // Both real KANJIDIC2 entries, with the JMdict facts that separate their
  // members: the -eru member is the transitive one for 立, the
  // *intransitive* one for 見 — which is exactly why the ending's shape
  // cannot decide this and the dictionary has to.
  const index: KanjidicIndex = {
    立: { on: ["リツ"], kun: ["た.つ", "た.てる"], meanings: ["stand up"] },
    見: { on: ["ケン"], kun: ["み.る", "み.える", "み.せる"], meanings: ["see"] },
    學: { on: ["ガク"], kun: ["まな.ぶ"], meanings: ["study"] },
    開: { on: ["カイ"], kun: ["ひら.く"], meanings: ["open"] },
    // Both real: 死's second "reading" is the 連用形 nominal KANJIDIC lists as
    // an affix, which is a second *dotted* entry with no verb behind it — so
    // the transitivity check runs on a pair whose second member the
    // dictionary knows nothing about.
    死: { on: ["シ"], kun: ["し.ぬ", "し.に-"], meanings: ["death"] },
    // 悔's third reading is a free adjective, not a bound form — the contrast
    // that separates "JMdict records no transitivity" from "this reading is
    // not a word the clause could be reading".
    悔: { on: ["カイ"], kun: ["く.いる", "く.やむ", "くや.しい"], meanings: ["regret"] },
  };
  const verb = (pos: string[]): JmdictIndex[string] => ({ reading: "", gloss: [], pos, common: true });
  const jmdict: JmdictIndex = {
    立つ: verb(["intransitive verb"]),
    立てる: verb(["transitive verb"]),
    見る: verb(["transitive verb"]),
    見える: verb(["intransitive verb"]),
    見せる: verb(["transitive verb"]),
    開く: verb(["intransitive verb", "transitive verb"]),
    死ぬ: verb(["intransitive verb"]),
    死に: verb(["noun (common) (futsuumeishi)"]),
    悔いる: verb(["transitive verb"]),
    悔やむ: verb(["transitive verb"]),
    悔しい: verb(["adjective (keiyoushi)"]),
  };
  const pick = (char: string, wantTransitive: boolean) => lookupKanji(index, char, "VERB", { wantTransitive, jmdict });

  it("takes the transitive member when the verb has an object", () => {
    expect(pick("立", true)).toMatchObject({ reading: "た", okurigana: "てる", transitivitySelected: true });
    expect(pick("見", true)).toMatchObject({ reading: "み", okurigana: "る" });
  });

  it("takes the intransitive member when it has none", () => {
    expect(pick("立", false)).toMatchObject({ reading: "た", okurigana: "つ" });
    expect(pick("見", false)).toMatchObject({ reading: "み", okurigana: "える", transitivitySelected: true });
  });

  it("flags a choice the transitivity question answered, agreeing or not", () => {
    // 立つ and 見る are each their entry's first inflecting reading, so these
    // are answers the ordering would have given anyway — and they are still
    // flagged, because the flag says the syntax decided, not that it
    // disagreed. Keying it on disagreement was a bug: 肥 with no object
    // resolves to こ.える, kanjidic's own first dotted reading, so nothing
    // was flagged and `VERB_LEXICON`'s transitive こ+やす overruled it.
    expect(pick("立", false)?.transitivitySelected).toBe(true);
    expect(pick("見", true)?.transitivitySelected).toBe(true);
  });

  it("flags nothing where transitivity separates none of the candidates", () => {
    // 去 lists さ.る and い.ぬ and JMdict calls both intransitive, so an
    // intransitive context matches the first of them while discriminating
    // nothing. Reported as a decision, it outranked `VERB_LEXICON`'s
    // sense-disambiguated 去ぬ and printed 去る.
    expect(pick("去", false)?.transitivitySelected).toBeUndefined();
  });

  it("flags nothing where the only partner is a bound affix form", () => {
    // 死's second dotted reading is the 連用形 nominal KANJIDIC marks with a
    // suffix hyphen, so 死 has exactly one verb and no choice to make. Counting
    // the bound form as a candidate manufactured one — 死ぬ matched the
    // objectless context and 死に (a noun in JMdict, so no transitivity)
    // supplied the opposing side — and the decision that reported stood down
    // `VERB_LEXICON`'s ナ変 死ぬ, leaving `classicalConjClass` to derive 四段
    // from the bare ぬ: 死者 printed 死ぬもの where ナ変 gives 死ぬるもの.
    expect(pick("死", false)?.transitivitySelected).toBeUndefined();
    expect(pick("死", true)?.transitivitySelected).toBeUndefined();
    expect(pick("死", false)).toMatchObject({ reading: "し", okurigana: "ぬ" });
  });

  it("still counts a free reading JMdict lists as a non-verb", () => {
    // The opposite case, and the reason the bound/free distinction is the one
    // that matters rather than "did JMdict record a transitivity": 悔しい is a
    // free adjective, listed, with no transitivity — and it is exactly what
    // separates 悔いる from the lexicon's 悔し, giving 王過を悔ゆ.
    expect(pick("悔", true)).toMatchObject({ reading: "く", okurigana: "いる", transitivitySelected: true });
  });

  it("has nothing to choose for a character with one inflecting reading", () => {
    expect(pick("學", true)).toMatchObject({ reading: "まな", okurigana: "ぶ" });
    expect(pick("學", false)).toMatchObject({ reading: "まな", okurigana: "ぶ" });
  });

  it("takes a verb the dictionary calls both, either way", () => {
    expect(pick("開", true)).toMatchObject({ okurigana: "く" });
    expect(pick("開", false)).toMatchObject({ okurigana: "く" });
  });

  it("falls back to the entry's own order where JMdict knows nothing", () => {
    expect(lookupKanji(index, "立", "VERB", { wantTransitive: true, jmdict: {} })).toMatchObject({ okurigana: "つ" });
  });
});

describe("種's supplementary classical kun'yomi", () => {
  const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "data");
  const kanjidic = JSON.parse(readFileSync(join(DATA_DIR, "kanjidic-index.json"), "utf-8")) as KanjidicIndex;

  it("offers う to a verb, which KANJIDIC2's own entry has no reading for at all", () => {
    // 植う, ワ行下二段 — the sense in 種樹 ("to plant trees"), which kanjidic
    // lists only under 植, never under 種.
    expect(kanjidic["種"].kun).not.toContain("う.");
    expect(candidateReadings(kanjidic, "種", "VERB").map((c) => c.reading)).toContain("う");
  });

  it("keeps it out of a noun's candidates, and leaves たね first among them", () => {
    const kun = candidateReadings(kanjidic, "種", "NOUN").filter((c) => c.kind === "kun");
    expect(kun[0].reading).toBe("たね");
    expect(kun.map((c) => c.reading)).not.toContain("う");
  });

  it("makes it the answer for a VERB and leaves the noun's answer untouched", () => {
    expect(lookupKanji(kanjidic, "種", "VERB")).toMatchObject({ reading: "う", okurigana: "" });
    expect(lookupKanji(kanjidic, "種", "NOUN")).toMatchObject({ reading: "たね" });
  });
});
