import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  candidateReadings,
  lookupKanji,
  onyomiOf,
  retainedAdverbOkurigana,
  seriesAmbiguousReading,
  type KanjidicIndex,
} from "../src/reading/kanjidicLookup.ts";
import {
  fullSizeKana,
  type HistoricalKanaIndex,
  historicalByReading,
  historicalSplitByReading,
  resetReadingTable,
} from "../src/reading/historicalKana.ts";
import type { JmdictIndex } from "../src/reading/jmdictLookup.ts";
import { LEXICON_SENSES } from "../src/kakikudashi/verbLexicon.ts";
import { AUXILIARY_LEMMAS, SENTENCE_FINAL_PARTICLE_LEMMAS, sentenceFinalParticle } from "../src/kakikudashi/bungoConjugation.ts";
import overridesData from "../src/reading/overrides.json";
import { KANJI_RETAINED_ADVERBS, retainedAdverbParts } from "../src/reading/classicalEnding.ts";

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

  it("offers a noun its bare kun'yomi, and an inflecting kun only nominalised", () => {
    const out = readings("中", "NOUN");
    expect(out).toContain("なか");
    expect(out).toContain("うち");
    // あた.る is in the list, but as the 連体形 of あたる rather than as the
    // finite verb reading a noun cannot take — 四段ラ行 spells the two alike,
    // so nothing here can tell them apart. The case that does separate them
    // (出's いづる against its finite でる) is in nominalReadings.test.ts.
    expect(out).toEqual(["ちゅう", "なか", "うち", "あた.る"]);
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
    // Four, not three: a nominalisation is a kun reading too, and 中's あたる
    // supplies one — see `nominalizedCandidates`.
    const kinds = candidateReadings(index, "中", "NOUN").map((c) => c.kind);
    expect(kinds).toEqual(["on", "kun", "kun", "kun"]);
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
    // なほ and not なお even with no historical-kana index passed: the verb
    // lexicon attests 直す as なほ + 四段サ行 and `attestedHistoricalReading`
    // takes it, which the index being absent has no bearing on. The hyphen is
    // what this case is about, and it is stripped either way.
    expect(out).toContain("なほ");
    expect(out.some((r) => r.includes("-"))).toBe(false);
  });

  it("folds a hyphenated form into the bare one already listed", () => {
    expect(candidateReadings(index, "木", "NOUN").map((c) => c.reading)).toEqual(["ぼく", "き", "こ"]);
    // なお.す + ちょく, and 直's own `overrides.json` entry reading ただ
    // ("merely") — a curated reading the resolver can return, so the menu
    // offers it. See `curatedCandidates`.
    expect(candidateReadings(index, "直", "VERB")).toHaveLength(3);
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
    // Asked of the なほ entries specifically: 直 also has a curated ただ, which
    // is a different reading and not part of what this is about.
    const kun = candidateReadings(index, "直", "VERB", historical).filter((c) => c.reading === "なほ");
    expect(kun.map((c) => c.okurigana)).toEqual(["す", "る"]);
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
    // すなはち also picks up its okurigana boundary here, from the same
    // attestation that gives it the spelling: KANJIDIC writes 則's すなわち
    // undivided, and the override table's 乃/則/即 all divide it すなは + ち.
    // See `historicalSplitByReading`.
    expect(kun("則")).toEqual(["のつと.る", "のり", "すなは.ち"]);
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
    // たか.し beside it is the verb lexicon's own sense of the character —
    // 貴し, ク活用 — which is a reading no kun list here or in the shipped
    // index carries and which `KundokuView.ts` draws over a VERB-tagged 貴.
    // See `curatedCandidates`.
    expect(kun("貴")).toEqual(["たふと.い", "たか.し"]);
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
    // The compound path omits the index on purpose — it compares a reading
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

  it("offers a noun only its 連体形, and leaves たね first among the candidates", () => {
    const kun = candidateReadings(kanjidic, "種", "NOUN").filter((c) => c.kind === "kun");
    expect(kun[0].reading).toBe("たね");
    // The finite 種う is still not offered to a noun. What is, is its 連体形
    // 種うる — a verb standing where a noun would, which is a reading of the
    // character and not a claim that 種 is that verb; see
    // `nominalizedCandidates`. たね goes on leading, and `lookupKanji` below
    // goes on answering with it.
    expect(kun.map((c) => c.reading + (c.okurigana ?? ""))).toContain("うる");
    expect(kun.map((c) => c.reading + (c.okurigana ?? ""))).not.toContain("う");
  });

  it("makes it the answer for a VERB and leaves the noun's answer untouched", () => {
    expect(lookupKanji(kanjidic, "種", "VERB")).toMatchObject({ reading: "う", okurigana: "" });
    expect(lookupKanji(kanjidic, "種", "NOUN")).toMatchObject({ reading: "たね" });
  });

  it("is unmoved by the supplement now leading kanjidic's own list", () => {
    // `SUPPLEMENTARY_KUN` was appended and is now prepended, so that a
    // character whose classical reading differs from KANJIDIC2's modern one
    // (首 かうべ vs くび) can be given the classical one as its default. These
    // two entries cannot feel it: both `pickKun` and `candidateReadings` split
    // the list by the okurigana dot before they look at order at all, and 種's
    // supplement is dotted where its kanjidic readings are not.
    expect(kanjidic["需"].kun).toEqual([]);
    // じゅ rather than じゆ only because no 歴史的仮名遣い index is passed here;
    // what this asserts is that the on'yomi is still what a nominal reaches.
    expect(lookupKanji(kanjidic, "需", "NOUN")).toMatchObject({ reading: "じゅ" });
    expect(lookupKanji(kanjidic, "需", "VERB")).toMatchObject({ reading: "もら", okurigana: "ふ" });
  });
});

describe("a reading attested on one character transfers to another", () => {
  // A reading's historical spelling is a fact about the word, so 輒's すなわち
  // — which nothing attests for 輒 — is 乃's すなはち. See
  // `historicalSplitByReading`.
  const overrides = [
    { reading: "すなは", okurigana: "ち" },
    { reading: "あひ" },
    { reading: "は" }, // 者: word-initial, and no modern spelling differs from it
  ];
  const index = { 乃: { すなわち: "すなはち" }, 相: { あい: "あひ" }, 藍: { あい: "あゐ" }, 磐: { わ: "は" } };

  it("carries the spelling to a character with no attestation of its own", () => {
    resetReadingTable();
    expect(historicalByReading(index, overrides, "すなわち")).toBe("すなはち");
  });

  it("carries the okurigana boundary with it", () => {
    resetReadingTable();
    // KANJIDIC writes 輒's kun undivided; the boundary comes from the same
    // place the spelling does.
    expect(historicalSplitByReading(index, overrides, "すなわち")).toMatchObject({ reading: "すなは", okurigana: "ち" });
  });

  it("abstains where two characters spell the same reading differently", () => {
    resetReadingTable();
    // 相 is あひ and 藍 is あゐ, so あい alone cannot say which 靛 wants.
    expect(historicalByReading(index, overrides, "あい")).toBeUndefined();
  });

  it("abstains on a difference that is not medial", () => {
    resetReadingTable();
    // 磐's わ->は is attested, but every such stem sits mid-word; 別 is わく
    // with わ word-initial and staying わ, and a bare one-kana reading cannot
    // tell the two apart. は行転呼 is medial by definition.
    expect(historicalByReading(index, overrides, "わ")).toBeUndefined();
  });
});

describe("an adjective kun'yomi is offered in its classical 終止形", () => {
  const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "data");
  const kanjidic = JSON.parse(readFileSync(join(DATA_DIR, "kanjidic-index.json"), "utf-8")) as KanjidicIndex;
  const jmdict = JSON.parse(readFileSync(join(DATA_DIR, "jmdict-index.json"), "utf-8")) as JmdictIndex;

  const kun = (char: string, pos?: string) =>
    candidateReadings(kanjidic, char, pos, undefined, jmdict)
      .filter((c) => c.kind === "kun")
      .map((c) => c.reading + (c.okurigana ?? ""));

  it("converts both of 易's, which KANJIDIC2 writes modern", () => {
    // The reported case: the annotation already read 易しき, and only the
    // menu still said やさシイ / やすイ.
    expect(kanjidic["易"].kun).toEqual(["やさ.しい", "やす.い"]);
    expect(kun("易", "VERB")).toEqual(["やさし", "やすし"]);
  });

  it("leaves the 連用形 nominals KANJIDIC2 writes with the same final い", () => {
    // 扱い "handling" and 向かい "facing" are nouns; there is no 扱し.
    expect(kun("扱", "VERB")).toContain("あつかい");
    expect(kun("扱", "VERB")).not.toContain("あつかし");
    expect(kun("向", "VERB")).toContain("むい");
    expect(kun("向", "VERB")).not.toContain("むし");
    expect(kun("向", "VERB")).not.toContain("むかし");
  });

  it("reaches a kyūjitai adjective through its 新字体 spelling", () => {
    // 淺い is absent from JMdict; 浅い is in it, read あさい.
    expect(kun("淺", "VERB")).toContain("あさし");
    expect(kun("險", "VERB")).toContain("けわし");
  });

  it("converts an entry KANJIDIC2 wrote without the okurigana dot", () => {
    expect(kanjidic["敏"].kun).toEqual(["さとい"]);
    expect(kun("敏")).toContain("さとし");
  });

  it("leaves an ending with a stem mora inside it rather than truncating", () => {
    // 危なし, not 危し — `classicalAdjectiveReading` replaces the whole
    // okurigana, so a multi-kana one would lose its stem kana.
    expect(kun("危", "VERB")).toContain("あぶない");
    expect(kun("危", "VERB")).not.toContain("あぶし");
  });

  it("leaves everything modern when no dictionary is supplied", () => {
    expect(candidateReadings(kanjidic, "易", "VERB").map((c) => c.reading + (c.okurigana ?? ""))).toContain("やすい");
  });
});

/** The menu spells its candidates in 歴史的仮名遣い, and the substitution that
 * does that is keyed by the *reading* — so an ending's own historical kana is
 * out of its reach. もちいる is the one kun'yomi where that matters: its ゐ is
 * inside the okurigana, and the menu offered the modern もちイル over an
 * annotation already reading もちヰル. See `LEXICAL_KUN`. */
describe("もちいる is offered as もちゐる", () => {
  const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "data");
  const kanjidic = JSON.parse(readFileSync(join(DATA_DIR, "kanjidic-index.json"), "utf-8")) as KanjidicIndex;
  const jmdict = JSON.parse(readFileSync(join(DATA_DIR, "jmdict-index.json"), "utf-8")) as JmdictIndex;

  const kun = (char: string, pos?: string) =>
    candidateReadings(kanjidic, char, pos, undefined, jmdict)
      .filter((c) => c.kind === "kun")
      .map((c) => c.reading + (c.okurigana ?? ""));

  it("converts it for every character KANJIDIC2 writes it under", () => {
    // 用 and 須 are the whole set, measured against the index — the word is
    // what is converted, not the character.
    expect(kanjidic["用"].kun).toEqual(["もち.いる"]);
    expect(kun("用", "VERB")).toEqual(["もちゐる"]);
    expect(kun("須", "VERB")).toContain("もちゐる");
    expect(kun("須", "VERB")).not.toContain("もちいる");
  });

  it("names the paradigm, which the converted ending no longer states", () => {
    // ワ行上一段: 未然 ゐ / 連用 ゐ / 終止 ゐる / 連体 ゐる / 已然 ゐれ / 命令 ゐよ.
    // Neither いる nor ゐる is a shape `classicalConjClass` reads a class off,
    // so without this a picked 用 could only stand at its citation form —
    // the same reason the adjectives above carry one.
    const picked = candidateReadings(kanjidic, "用", "VERB", undefined, jmdict).find((c) => c.reading === "もち");
    expect(picked).toMatchObject({ okurigana: "ゐる", conjClass: "kami-ichidan" });
  });

  it("leaves the neighbouring -いる verbs alone, which are ヤ行上二段", () => {
    // 老ゆ, 悔ゆ, 報ゆ — a 終止形 in ゆ, no ゐ in the paradigm at all. Nothing
    // in the ending separates them from もちいる, which is exactly why this
    // is a word list and not a row on `KAMI_NIDAN_SHUUSHI`.
    expect(kun("老", "VERB")).toContain("おいる");
    expect(kun("悔", "VERB")).toContain("くいる");
    expect(kun("報", "VERB")).toEqual(["むくいる"]);
    // 強いる is ハ行上二段 強ふ — a third answer again for the same shape.
    expect(kun("強", "VERB")).toContain("しいる");
  });
});

/** A ハ行四段 verb is offered on its own 終止形 — 買フ, not 買ウ.
 *
 * The menu is written in the orthography the page is written in, which is what
 * `classicalAdjectiveKun` already settled for the adjectives (易シ, not 易イ)
 * and what a bare modern う was still contradicting. See `hagyouShuushi` in
 * `classicalEnding.ts` for the whole of the conversion, and for the two
 * boundaries it holds: only a *one-kana* う, and only う. */
describe("a ハ行四段 kun'yomi is offered as ふ, not う", () => {
  const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "data");
  const kanjidic = JSON.parse(readFileSync(join(DATA_DIR, "kanjidic-index.json"), "utf-8")) as KanjidicIndex;
  const jmdict = JSON.parse(readFileSync(join(DATA_DIR, "jmdict-index.json"), "utf-8")) as JmdictIndex;

  const kun = (char: string, pos?: string) =>
    candidateReadings(kanjidic, char, pos, undefined, jmdict)
      .filter((c) => c.kind === "kun")
      .map((c) => c.reading + (c.okurigana ?? ""));

  it.each([
    ["買", "かふ"],
    ["言", "いふ"],
    ["習", "ならふ"],
    ["洗", "あらふ"],
    ["適", "かなふ"],
  ])("offers %s as %s", (char, expected) => {
    expect(kun(char, "VERB")).toContain(expected);
    expect(kun(char, "VERB")).not.toContain(expected.slice(0, -1) + "う");
  });

  it("leaves a 一段 ending in its modern shape, because the class is read back off it", () => {
    // 起's き.る is 上二段 起く and こ.る is 四段ラ行 起こる, and the difference
    // survives only in the modern spelling: a menu that offered 起ク would be
    // storing an ending `classicalConjClass` can only read as 四段カ行. う -> ふ
    // is safe for exactly the opposite reason — both spellings give 四段ハ行.
    expect(kun("起", "VERB")).toContain("おきる");
    expect(kun("立", "VERB")).toContain("たてる");
  });

  it("leaves a longer う-final ending alone, where the shape stops being evidence", () => {
    // 逆's さか.らう is 逆らふ and 行's おこ.なう is 行なふ, both ハ行 — but 向's
    // む.こう is the noun 向こう, whose こう is not an ending at all, and nothing
    // in the shape separates the three. The 541 bare-う endings have no such
    // counterexample; these 36 are left as KANJIDIC2 wrote them.
    expect(kun("向", "VERB")).toContain("むこう");
    expect(kun("逆", "VERB")).toContain("さからう");
  });

  it("does not touch an い-final adjective, which the classical gate has already converted", () => {
    // The conversion runs on what that gate returns, not beside it: 易's やす.い
    // comes back やすし, and asking `hagyouShuushi` of a し leaves it alone.
    expect(kun("易", "VERB")).toContain("やすし");
    expect(kun("易", "VERB")).not.toContain("やすい");
  });
});

/** **The reading on the page is always one of the menu's own entries.**
 *
 * `openReadingMenu` builds its list from `candidateReadings` and marks the
 * entry that equals the annotation it is opened over, so a reading the page
 * can show and the menu cannot offer fails twice: the reader cannot get back
 * to it once they have picked something else, and nothing in the menu shows as
 * current. `candidateReadings` read KANJIDIC2 alone while the page's reading
 * comes from four further tables — see `curatedCandidates`, which is where
 * those tables are now read too.
 *
 * These are the invariants rather than a list of characters: each one asks of
 * a whole shipped table that every reading it can put on a character is one of
 * that character's candidates. */
describe("every reading the app can show is offered", () => {
  const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "data");
  const kanjidic = JSON.parse(readFileSync(join(DATA_DIR, "kanjidic-index.json"), "utf-8")) as KanjidicIndex;
  const jmdict = JSON.parse(readFileSync(join(DATA_DIR, "jmdict-index.json"), "utf-8")) as JmdictIndex;
  const historical = JSON.parse(readFileSync(join(DATA_DIR, "historical-kana-index.json"), "utf-8")) as HistoricalKanaIndex;

  const offered = (char: string, pos?: string) =>
    candidateReadings(kanjidic, char, pos, historical, jmdict).map((c) => c.reading);
  const whole = (char: string, pos?: string) =>
    candidateReadings(kanjidic, char, pos, historical, jmdict).map((c) => c.reading + (c.okurigana ?? ""));

  it("offers every curated reading of every character in overrides.json", () => {
    // Single-character entries only. The table also holds the multi-character
    // formulae (何以 なにをもつてか, 於是 ここにおいて), which `findOverride`
    // reaches by a fused span's concatenated text; those have no per-character
    // menu to be offered in — a character inside a compound group gets
    // `compoundMemberCandidates` instead — and are a separate question from
    // this one.
    const missing = (overridesData as { char: string; reading: string; contextPos?: string[] }[])
      .filter((entry) => [...entry.char].length === 1)
      .filter((entry) => !offered(entry.char, entry.contextPos?.[0]).includes(entry.reading))
      .map((entry) => `${entry.char}=${entry.reading}`);
    expect(missing).toEqual([]);
  });

  it("offers the reading the verb lexicon draws, for every single-character lemma it holds", () => {
    // The same fold `lexiconFurigana` in `KundokuView.ts` applies before
    // drawing the reading: the historical-kana index for this character, the
    // full-size fall-back after it, and neither where the key is ambiguous
    // between the character's two series. That is the string that reaches the
    // `<rt>`, so that is the string the menu has to be able to name.
    const drawn = (char: string, reading: string) =>
      seriesAmbiguousReading(kanjidic, char, reading)
        ? fullSizeKana(reading)
        : historical[char]?.[reading] ?? fullSizeKana(reading);
    const missing: string[] = [];
    for (const [char, senses] of Object.entries(LEXICON_SENSES)) {
      if ([...char].length !== 1 || !kanjidic[char]) continue;
      for (const sense of senses) {
        if (!sense.reading) continue;
        const reading = drawn(char, sense.reading);
        if (!offered(char, "VERB").includes(reading)) missing.push(`${char}=${reading}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("offers every sentence-final particle reading", () => {
    const missing = [...SENTENCE_FINAL_PARTICLE_LEMMAS]
      .filter((lemma) => sentenceFinalParticle(lemma) && !offered(lemma).includes(sentenceFinalParticle(lemma)))
      .map((lemma) => `${lemma}=${sentenceFinalParticle(lemma)}`);
    expect(missing).toEqual([]);
  });

  /** Every part of speech an auxiliary can arrive tagged with, and the point is
   * that the list is not narrowed: `AUXILIARY_LEMMAS` is keyed on the lemma and
   * `auxiliaryFormFor` adds only the 再読 test, so nothing on the path from that
   * table to the cell consults a tag. A 令 tagged NOUN renders シム exactly as a
   * VERB one does — measured, on a tree with 令 hand-tagged NOUN — so the menu
   * has to offer しむ at every one of these. */
  const EVERY_POS = [undefined, "VERB", "AUX", "ADV", "PART", "NOUN", "PRON", "PROPN"];

  it("offers the auxiliary reading of every lemma in AUXILIARY_LEMMAS, at every part of speech", () => {
    // The three this arm was added for were measured unmarkable on the page:
    // 能 rendering ベシ against なう/よク/あたフ/よく, 欲 rendering マホシ against
    // よく/ほつスル/ほシ/ほつす, and 遣 rendering シム against a menu carrying no
    // しむ at all. The other eight were covered only by `overrides.json` and the
    // 再読 table happening to say the same thing on their behalf.
    const missing: string[] = [];
    for (const [lemma, form] of Object.entries(AUXILIARY_LEMMAS)) {
      for (const pos of EVERY_POS) {
        if (!offered(lemma, pos).includes(form.primary)) missing.push(`${lemma}=${form.primary}@${pos ?? "—"}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("offers each auxiliary reading exactly once, whatever else names it", () => {
    // `overrides.json` states べし for 可 and しむ for 使/令/教 on its own
    // account, and that arm runs first — so this one's entry for those four has
    // to fold into it rather than stand beside it. The de-duplication in
    // `candidateReadings` is what does the folding, by reading *and* ending, and
    // this is the assertion that it does: a menu listing べし twice would be
    // worse than the missing entry that was there before.
    const duplicated: string[] = [];
    for (const [lemma, form] of Object.entries(AUXILIARY_LEMMAS)) {
      for (const pos of EVERY_POS) {
        const named = candidateReadings(kanjidic, lemma, pos, historical, jmdict).filter(
          (c) => c.reading === form.primary,
        );
        if (named.length !== 1) duplicated.push(`${lemma}@${pos ?? "—"}×${named.length}`);
      }
    }
    expect(duplicated).toEqual([]);
  });

  it("offers an auxiliary as a whole word, with no ending and no paradigm", () => {
    // The shape is forced by how the cell is marked, not chosen: an auxiliary is
    // written wholly in the okurigana slot with nothing over the character, so
    // `openReadingMenu` cannot read the `<rt>` for it and compares a candidate's
    // `reading` against the citation `cellFor` recorded as `data-kana-reading` —
    // which is the paradigm's `primary`, entire. A candidate divided into stem
    // and ending would equal no citation and mark nothing.
    //
    // And the paradigm cannot ride along on a reading in that shape.
    // `conjugatedOkurigana` only ever *appends* a suffix, so a class named here
    // would print 能[べし]シ and 令[しむ]ム — the word's own tail written twice.
    // A picked auxiliary therefore stands at its citation form, which is what
    // 可's and 使's identical override entries have always done.
    for (const [lemma, form] of Object.entries(AUXILIARY_LEMMAS)) {
      const named = candidateReadings(kanjidic, lemma, undefined, historical, jmdict).filter(
        (c) => c.reading === form.primary,
      );
      expect(named).toEqual([expect.objectContaining({ kind: "kun" })]);
      expect(named[0].okurigana).toBeUndefined();
      expect(named[0].conjClass).toBeUndefined();
    }
  });

  it("lets no curated reading survive as a 訓読み spelled like its own on'yomi", () => {
    // The claim `curatedCandidates` makes about why every one of its candidates
    // may be grouped under 訓読み without checking: the 音読み heading is the
    // *dictionary's* own on series, which `fromOn` lists in full and ahead of
    // this, so a curated reading spelled like one of those is folded into it by
    // the de-duplication and never reaches the menu twice or under the wrong
    // heading. **Not** that no curated reading is ever spelled that way — 謂's
    // lexicon reading い and 仁's じん both are, and there are twenty-odd more —
    // but that none of them survives to be listed as a kun.
    //
    // Three mechanisms stand such a reading down and the test cannot tell them
    // apart, which is the point of asking of the output rather than of the
    // tables: the auxiliary and lexicon arms defer to `alreadyOffered` and never
    // emit one, the de-duplication folds what the override and particle arms do
    // emit, and where the on'yomi is *folded* into 歴史的仮名遣い (謂's イ is
    // listed ゐ, 放's ホウ はう) the collision is with the character's own kun
    // stem instead — 謂's い.ふ, 放's ほう.る — which stands the same reading
    // down by the same rule. Either way nothing survives as a bare 訓読み.
    //
    // Re-derived here over all four tables that state a reading, rather than
    // asserted in the comment alone — the auxiliaries are the newest of them and
    // the whole point of an invariant test is that a table can grow.
    const onyomi = (char: string) => {
      const raw = onyomiOf(kanjidic, char);
      // Both spellings, since `candidateReadings` folds an on'yomi into
      // 歴史的仮名遣い before listing it and a curated reading is written in that
      // orthography already: しゅく is listed しゆく, and a curated しゆく would
      // collide with the listed form rather than with kanjidic's own.
      return new Set([...raw, ...raw.map((on) => historical[char]?.[on] ?? fullSizeKana(on))]);
    };
    const curated: [string, string][] = [];
    for (const entry of overridesData as { char: string; reading: string; okurigana?: string }[]) {
      // Bare entries only. One that states its own okurigana is a division —
      // the reading over the character, the ending beside it — and its reading
      // is a *stem*, which is a different menu item from the on'yomi spelled
      // alike and is meant to stand beside it (以's もつ + て against い).
      if ([...entry.char].length === 1 && !entry.okurigana) curated.push([entry.char, entry.reading]);
    }
    for (const [char, senses] of Object.entries(LEXICON_SENSES)) {
      if ([...char].length !== 1) continue;
      for (const sense of senses) {
        if (!sense.reading) continue;
        const drawn = seriesAmbiguousReading(kanjidic, char, sense.reading)
          ? fullSizeKana(sense.reading)
          : historical[char]?.[sense.reading] ?? fullSizeKana(sense.reading);
        curated.push([char, drawn]);
      }
    }
    for (const lemma of SENTENCE_FINAL_PARTICLE_LEMMAS) {
      if (sentenceFinalParticle(lemma)) curated.push([lemma, sentenceFinalParticle(lemma)]);
    }
    for (const [lemma, form] of Object.entries(AUXILIARY_LEMMAS)) curated.push([lemma, form.primary]);

    const survived: string[] = [];
    for (const [char, reading] of curated) {
      if (!onyomi(char).has(reading)) continue;
      for (const pos of EVERY_POS) {
        // A bare entry under the 訓読み heading spelled exactly like the
        // character's on'yomi is what must not exist. An entry carrying an
        // ending is a different menu item and is not what the claim is about —
        // 放's ほう.る stands beside its ホウ legitimately.
        const survivors = candidateReadings(kanjidic, char, pos, historical, jmdict).filter(
          (c) => c.reading === reading && c.okurigana === undefined && c.kind !== "on",
        );
        if (survivors.length > 0) survived.push(`${char}=${reading}@${pos ?? "—"}`);
      }
    }
    expect(survived).toEqual([]);
  });

  it("offers a divided word in both of its divisions, since both reach the page", () => {
    // 一番僧見之 writes これヲ — the case particle takes the ending slot, so the
    // reading stays whole — and 曰：「有之。」 four sentences later writes こレ.
    // A menu offering one of them leaves the other occurrence marking nothing.
    // See `READING_ENDING_SPLITS`.
    for (const char of ["之", "此", "是"]) {
      expect(offered(char, "PRON")).toContain("これ");
      expect(candidateReadings(kanjidic, char, "PRON", historical, jmdict)).toContainEqual(
        expect.objectContaining({ reading: "こ", okurigana: "れ" }),
      );
    }
    // より is ADP-only: 自's char-only entry reads より outside an adposition
    // slot, and 由's own ADV entry is なほ, a different word.
    expect(candidateReadings(kanjidic, "自", "ADP", historical, jmdict)).toContainEqual(
      expect.objectContaining({ reading: "よ", okurigana: "り" }),
    );
    expect(candidateReadings(kanjidic, "自", "PRON", historical, jmdict)).not.toContainEqual(
      expect.objectContaining({ reading: "よ", okurigana: "り" }),
    );
  });

  it("offers a kanji-retained adverb in both divisions, for the same reason", () => {
    // The second table that divides a reading between the two annotation slots.
    // 豈 and 固 are the two the reader's own 酒蟲 has: the page writes あ over 豈
    // with ニ beside it and もと over 固 with ヨリ, while the menu listed the
    // whole あに and もとより — so nothing matched and nothing was marked.
    const parts = (char: string, pos: string) =>
      candidateReadings(kanjidic, char, pos, historical, jmdict).map((c) => `${c.reading}|${c.okurigana ?? ""}`);
    expect(parts("豈", "ADV")).toEqual(expect.arrayContaining(["あに|", "あ|に"]));
    expect(parts("固", "ADV")).toEqual(expect.arrayContaining(["もとより|", "もと|より"]));

    // Every other entry of the table, whatever route its whole reading reaches
    // the menu by — several are divided already by KANJIDIC2's own dot (甚's
    // はなは.だ, 但's ただ.し) and this must not disturb those. The division is
    // that same dot, read back out of the index rather than copied.
    const missing: string[] = [];
    for (const char of Object.keys(KANJI_RETAINED_ADVERBS)) {
      const okurigana = retainedAdverbOkurigana(kanjidic, char, historical);
      if (!okurigana) continue;
      const list = candidateReadings(kanjidic, char, "ADV", historical, jmdict);
      for (const candidate of list) {
        if (candidate.okurigana !== undefined) continue;
        const divided = retainedAdverbParts(candidate.reading, okurigana);
        if (!divided?.okurigana) continue;
        if (!list.some((c) => c.reading === divided.reading && c.okurigana === divided.okurigana)) {
          missing.push(`${char}=${candidate.reading}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it("adds no division for an adverb the table writes with nothing beside it", () => {
    // 亦, 皆, 尚, 猶 and 益 are in that table to say the character is kept and
    // the whole reading goes over it. Their "division" is the reading the list
    // already carries, and offering it again would put また on the menu twice.
    for (const char of ["亦", "皆", "尚", "猶", "益"]) {
      const list = candidateReadings(kanjidic, char, "ADV", historical, jmdict);
      expect(list.filter((c) => c.okurigana === "")).toEqual([]);
      expect(new Set(whole(char, "ADV")).size).toBe(whole(char, "ADV").length);
    }
  });

  it("offers the curated split readings in the shape the page writes them", () => {
    // Each of these states its own okurigana in `overrides.json`, and
    // `KundokuView.ts` reads that as a division: the reading over the
    // character, the ending beside it. 非 is the one a previous round found
    // with the whole gloss in one slot, so nothing in its menu could equal
    // what was shown.
    const parts = (char: string, pos: string) =>
      candidateReadings(kanjidic, char, pos, historical, jmdict).map((c) => `${c.reading}|${c.okurigana ?? ""}`);
    expect(parts("其", "PRON")).toContain("そ|の");
    expect(parts("以", "ADP")).toContain("もつ|て");
    expect(parts("非", "ADV")).toContain("あら|ず");
    expect(parts("或", "PRON")).toContain("あ|るひと");
    expect(parts("每", "ADP")).toContain("ごと|に");
  });

  it("offers 否 both of its words, the verb and the question tag", () => {
    // The reported case. 否 is 否ム by `VERB_LEXICON` — 四段マ行, a reading
    // KANJIDIC2 lists only as the bare nominal いな, which the inflecting
    // filter drops for a VERB — and its menu offered ヒ and nothing else.
    // It is also the alternative-question tag read や (然歟否歟？), which is a
    // different table again.
    expect(kanjidic["否"].kun).toEqual(["いな", "いや"]);
    expect(whole("否", "VERB")).toContain("いなむ");
    expect(offered("否", "VERB")).toContain("や");
    expect(offered("否", "PART")).toContain("や");
    // The paradigm travels with the ending, or a picked 否 would stand at 否む
    // wherever it fell: nothing downstream can read 四段マ行 back off a bare む
    // written out of the class rather than taken from KANJIDIC2.
    expect(candidateReadings(kanjidic, "否", "VERB", historical, jmdict)).toContainEqual(
      expect.objectContaining({ reading: "いな", okurigana: "む", conjClass: "yodan-ma" }),
    );
  });

  it("offers 曰 both endings, which are two different occurrences", () => {
    // 曰ハク introduces speech and 曰フ does not, and `isNamingUse` decides
    // which — so both reach the page and both are offered.
    expect(whole("曰", "VERB")).toEqual(expect.arrayContaining(["いはく", "いふ"]));
  });

  it("does not add a second ending for a reading the dictionary already lists", () => {
    // The lexicon is derived data and its endings are where the doubt is: 危 as
    // あぶ + シク活用 would be offered as あぶし, the very truncation of あぶない
    // that `classicalAdjectiveKun` refuses. The reading あぶ is already on the
    // list under KANJIDIC2's own ending, so it is already findable and already
    // markable, and the sense is skipped.
    expect(whole("危", "VERB")).toContain("あぶない");
    expect(whole("危", "VERB")).not.toContain("あぶし");
    // 用's three lexicon senses are one reading もち, which KANJIDIC2 lists.
    expect(whole("用", "VERB")).toEqual(["やう", "もちゐる"]);
  });
});
