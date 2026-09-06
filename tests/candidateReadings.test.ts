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
  historicalSpelling,
  historicalSplitByReading,
  resetReadingTable,
} from "../src/reading/historicalKana.ts";
import type { JmdictIndex } from "../src/reading/jmdictLookup.ts";
import { LEXICON_SENSES } from "../src/kakikudashi/verbLexicon.ts";
import {
  AUXILIARY_LEMMAS,
  GENUINE_QUESTION_PARTICLE_LEMMAS,
  genuineQuestionParticle,
  SENTENCE_FINAL_PARTICLE_LEMMAS,
  sentenceFinalParticle,
} from "../src/kakikudashi/bungoConjugation.ts";
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

  it("folds a fused long vowel too, which it once declined to", () => {
    // ょう/ゅう really are a long vowel rather than 拗音, and けう/きやう/きよう
    // all give the modern きょう, so ちよう is a guess where てふ may be the
    // truth. The exemption that used to protect them left the *modern* spelling
    // standing instead, which is not an abstention but a reading written in the
    // other orthography — 1,132 of them, on 1,008 of the shipped index's 12,356
    // characters. See `fullSizeKana`, which now says so at length.
    expect(fullSizeKana("ひょう")).toBe("ひよう");
    expect(fullSizeKana("じゅう")).toBe("じゆう");
    expect(fullSizeKana("どじょう")).toBe("どじよう");
  });

  it("folds ゎ, which 合拗音 is written full-size with — くわ, not くゎ", () => {
    // Not a nicety: the index attests くゎう on 21 characters in Wiktionary's
    // convention while carrying 郭's くわく in this app's, so the data
    // contradicted itself and the table had no ゎ entry to settle it with.
    expect(fullSizeKana("くゎう")).toBe("くわう");
    expect(fullSizeKana("ぐゎん")).toBe("ぐわん");
  });

  it("folds katakana as well, which the 訓読文 panel writes okurigana in", () => {
    expect(fullSizeKana("シヤク")).toBe("シヤク");
    expect(fullSizeKana("ジョウ")).toBe("ジヨウ");
    expect(fullSizeKana("モツテ")).toBe("モツテ");
    expect(fullSizeKana("モッテ")).toBe("モツテ");
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

  it("folds a small kana before う as well, in a kun'yomi", () => {
    // どじょう is historically どぢやう and this cannot know that. What it can
    // do is not print どじょう, which is neither どぢやう nor an orthography this
    // app writes anything else in.
    expect(kun("鰍")).toEqual(["かじか", "どじよう"]);
  });

  it("folds an on'yomi too, where nothing attests or derives one", () => {
    // The real abstention is still available and is made earlier: on'yomi have
    // their own source in `derive-onyomi-kana.py`, which derives a spelling from
    // the 廣韻's rime data and stays silent where the rime data cannot decide.
    // Its output is merged into the shipped index, which is why 蟲 ちゆう and
    // 尺 しやく never reach the fold at all. What reaches it is what nothing
    // attests and nothing derives, and for that the app's own convention is the
    // only thing left to be right about.
    expect(candidateReadings(index, "鰍", undefined, historical).filter((c) => c.kind === "on")[0].reading).toBe("しゆう");
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
    // 扱い "handling" and 向かい "facing" are nouns; there is no 扱し. This is
    // the *adjective* gate's boundary and it is unchanged — what the ending
    // must not become is し.
    //
    // 扱's い has since become ひ, and by a different rule: 扱ふ is ハ行四段 and
    // its 連用形 nominal is 扱ひ, which `pairedRenyouNominalKun` writes off the
    // あつか.う sibling standing on the same menu. 向 keeps its い and is the
    // reason that rule matches a sibling's *whole* okurigana: む.かう ends in
    // う without being ハ行, and 向い is the イ音便 stem of 向く.
    expect(kun("扱", "VERB")).toContain("あつかひ");
    expect(kun("扱", "VERB")).not.toContain("あつかし");
    expect(kun("向", "VERB")).toContain("むい");
    expect(kun("向", "VERB")).toContain("むかい");
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

  it("does not give the neighbouring -いる verbs もちゐる's ゐ, which is the point", () => {
    // 老ゆ, 悔ゆ, 報ゆ — a 終止形 in ゆ, no ゐ in the paradigm at all. Nothing in
    // the *ending* separates them from もちいる, which is exactly why this is a
    // word list and not a row on `KAMI_NIDAN_SHUUSHI`.
    //
    // What reaches them instead is `classicalVerbKun`, which asks for the
    // paradigm rather than converting the string, and gets ヤ行上二段 from
    // JMdict's own classical headwords — so they are offered on the 終止形 that
    // class states. Each of the three is `attestedClassicalParadigm`'s own
    // worked example, and none of them ends in ゐ or in る.
    expect(kun("老", "VERB")).toContain("おゆ");
    expect(kun("悔", "VERB")).toContain("くゆ");
    expect(kun("報", "VERB")).toEqual(["むくゆ"]);
    expect(kun("老", "VERB")).not.toContain("おいる");
    // 強いる is ハ行上二段 強ふ — a third answer again for the same shape, and
    // reached the same way.
    expect(kun("強", "VERB")).toContain("しふ");
  });
});

/** **A verb is offered on its classical 終止形, whatever row it is in** — 覺ユ
 * and 出ヅ and 起ク, not the 覺エル, 出デル and 起キル KANJIDIC2 writes.
 *
 * The reader's objection, and it is the same one `classicalAdjectiveKun`
 * answered for the adjectives and `hagyouShuushi` for one kana of one row: a
 * menu spelled in modern Japanese, offered beside a page written in classical
 * Japanese, is not offering the reader a choice they are actually making. The
 * ending エル / レル / チル is 下一段・上一段 morphology and this app never prints
 * it.
 *
 * See `classicalVerbKun`, which is where the conversion lives, for the three
 * sources it asks and for why the ending is written *out of the paradigm*
 * rather than converted from the string. */
describe("an inflecting kun'yomi is offered on its classical 終止形", () => {
  const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "data");
  const kanjidic = JSON.parse(readFileSync(join(DATA_DIR, "kanjidic-index.json"), "utf-8")) as KanjidicIndex;
  const jmdict = JSON.parse(readFileSync(join(DATA_DIR, "jmdict-index.json"), "utf-8")) as JmdictIndex;

  const kun = (char: string) =>
    candidateReadings(kanjidic, char, "VERB", undefined, jmdict)
      .filter((c) => c.kind === "kun")
      .map((c) => c.reading + (c.okurigana ?? ""));
  const entry = (char: string, reading: string) =>
    candidateReadings(kanjidic, char, "VERB", undefined, jmdict).find((c) => c.kind === "kun" && c.reading === reading);

  it("takes the paradigm from this project's own lexicon where it has one", () => {
    // 覺 is the reader's own case and the one no shape rule could reach:
    // `classicalConjClass` declines the あ row outright, because a modern -eru
    // with a bare え could be ア行, ヤ行 or ワ行下二段. `LEXICON_SENSES` holds
    // 覺's おぼ as 下二段ヤ行, whose 終止形 is おぼゆ, and its さ as a separate
    // 下二段マ行 覺む.
    expect(entry("覺", "おぼ")).toMatchObject({ okurigana: "ゆ", conjClass: "shimo-nidan-ya" });
    expect(kun("覺")).not.toContain("おぼえる");
    expect(entry("覺", "さ")).toMatchObject({ okurigana: "ます" });
    expect(kun("覺")).toContain("さむ");
    expect(kun("覺")).not.toContain("さめる");
    // 肥's こ.える is the same row and the same answer — 肥ゆ, which is what the
    // resolver already reads for an unpinned 馬肥.
    expect(entry("肥", "こ")).toMatchObject({ okurigana: "ゆ", conjClass: "shimo-nidan-ya" });
  });

  it("takes it from the shape tables for the regular 二段", () => {
    expect(entry("出", "い")).toMatchObject({ okurigana: "づ", conjClass: "shimo-nidan-da" });
    expect(entry("起", "お")).toMatchObject({ okurigana: "く", conjClass: "kami-nidan-ka" });
    expect(kun("出")).not.toContain("いでる");
    expect(kun("起")).not.toContain("おきる");
  });

  it("takes it from JMdict's classical headwords for the row the tables decline", () => {
    // `attestedClassicalParadigm`'s own worked example: 應/答's こた.える is
    // 下二段ハ行 答ふ, which no shape rule and no entry of this project's own
    // states.
    expect(entry("應", "こた")).toMatchObject({ okurigana: "ふ", conjClass: "shimo-nidan-ha" });
    expect(entry("老", "お")).toMatchObject({ okurigana: "ゆ", conjClass: "kami-nidan-ya" });
  });

  it("keeps a stem mora that lives inside the okurigana", () => {
    // 果's は.たす is 四段サ行 with a た, and 試's こころ.みる is 上一段 with a み.
    // Both are already their own classical 終止形 including that prefix, so the
    // conversion has nothing to do and returns them untouched — and asserting
    // it is worth the line, because a class written out bare would have printed
    // 果す and 試る.
    expect(kun("果")).toContain("はたす");
    expect(kun("試")).toContain("こころみる");
    // …while 果's *other* word, は.てる, is 下二段タ行 果つ and does convert.
    expect(entry("果", "は")).toMatchObject({ okurigana: "たす" });
    expect(kun("果")).toContain("はつ");
  });

  it("claims nothing where the ending was already the 終止形", () => {
    // A one-kana modern okurigana is its own classical 終止形, and it is also
    // where `classicalConjClass`'s 四段 answer is a guess. 墮 is the case and the
    // guess is wrong — KANJIDIC2 divides the kyūjitai as おち.る where it divides
    // the shinjitai 堕 as お.ちる, and only the second reaches 上二段タ行 落つ. The
    // candidate is returned exactly as it arrived, with no paradigm attached,
    // rather than having the guess written into the menu as an established one.
    expect(entry("墮", "おち")).toMatchObject({ okurigana: "る" });
    expect(entry("墮", "おち")?.conjClass).toBeUndefined();
    // The shinjitai, whose division does reach it:
    expect(entry("堕", "お")).toMatchObject({ okurigana: "つ", conjClass: "kami-nidan-ta" });
    // 惡's にく.む is 四段マ行 either way, and takes no class for the same
    // reason. Found by its ending rather than by its reading, because 惡 also
    // has にく.い — the ク活用 adjective 惡し — and the two share a stem: a pair
    // the de-duplication now keeps apart precisely because their classes
    // differ.
    const nikumu = candidateReadings(kanjidic, "惡", "VERB", undefined, jmdict).find(
      (c) => c.reading === "にく" && c.okurigana === "む",
    );
    expect(nikumu).toBeDefined();
    expect(nikumu?.conjClass).toBeUndefined();
  });

  it("leaves the readings that are not verbs at all alone", () => {
    // The gate is `splitKunWordClass`: a nominal (no dot), a 連用形 nominal or
    // ナリ活用 stem or adverb (`"unstated"`), and an い-final reading, which is
    // the adjective conversion's business and has already been spent.
    expect(kun("易")).toContain("やすし");
    expect(kun("癢")).toEqual(["かゆし"]);
    expect(kun("安")).toContain("やすらか");
    expect(kun("向")).toContain("むこう");
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

  it("converts a 一段 ending too, now that the class travels with it", () => {
    // **This test asserted the opposite until `classicalVerbKun` existed**, and
    // the reason it gave was sound at the time: 起's き.る is 上二段 起く and
    // こ.る is 四段ラ行 起こる, the difference survives only in the modern
    // spelling, and a menu that offered 起ク would have been storing an ending
    // `classicalConjClass` can only read back as 四段カ行. う -> ふ was safe for
    // exactly the opposite reason — both spellings give 四段ハ行.
    //
    // What lifts the bound is that the paradigm is now stored beside the
    // converted ending rather than re-derived from it, which is the arrangement
    // the adjectives have had all along (see `CONJ_CLASS_KEY`). So the ending
    // may be as lossy as it needs to be, and the menu is written in the grammar
    // the page is written in.
    expect(kun("起", "VERB")).toContain("おく");
    expect(kun("起", "VERB")).not.toContain("おきる");
    expect(kun("立", "VERB")).toContain("たつ");
    expect(kun("立", "VERB")).not.toContain("たてる");
  });

  it("keeps both paradigms where two of a character's words share a 終止形", () => {
    // 立's た.つ and た.てる are 四段タ行 and 下二段タ行 and both are 立つ; 破's
    // やぶ.る and やぶ.れる are 四段ラ行 and 下二段ラ行 and both are 破る. Keyed on
    // the string alone the second collapsed into the first and the 下二段 became
    // unreachable from the menu — which is the distinction `CONJ_CLASS_KEY`
    // calls "the whole difference between 廟を立てて and 廟立ちて". The
    // de-duplication takes the class into account for that reason.
    const classesFor = (char: string, reading: string, okurigana: string) =>
      candidateReadings(kanjidic, char, "VERB", undefined, jmdict)
        .filter((c) => c.reading === reading && c.okurigana === okurigana)
        .map((c) => c.conjClass);
    expect(classesFor("立", "た", "つ")).toEqual([undefined, "shimo-nidan-ta"]);
    expect(classesFor("破", "やぶ", "る")).toEqual([undefined, "shimo-nidan-ra"]);
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

/** **The 行 a bare える cannot state, read off the character's own other
 * reading** — see `pairedARowKun`.
 *
 * The reader's report is 伝: a menu offering つた.える, the modern 下一段 form,
 * beside つた.ふ. `classicalVerbKun` abstains there on purpose (a modern -eru
 * with no consonant before the え could be ア行, ヤ行, ワ行 or ハ行下二段), and
 * where it abstains the modern ending survives — which is only tolerable while
 * no classical form of the same stem is standing next to it.
 *
 * The two are **not** one word, and the tests below turn on that: 伝ふ 四段 is
 * "to go along" and 伝ふ 下二段 is "to transmit", the only reading 傳 takes in a
 * Literary Chinese text. So the modern member is converted rather than dropped,
 * and both survive the de-duplication for exactly the reason 立's た.つ and
 * た.てる do — the key carries the class, and one of the two now has one. */
describe("the 行 an あ row ending cannot state comes from a paired reading", () => {
  const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "data");
  const kanjidic = JSON.parse(readFileSync(join(DATA_DIR, "kanjidic-index.json"), "utf-8")) as KanjidicIndex;
  const jmdict = JSON.parse(readFileSync(join(DATA_DIR, "jmdict-index.json"), "utf-8")) as JmdictIndex;

  const menu = (char: string, pos = "VERB") => candidateReadings(kanjidic, char, pos, undefined, jmdict);
  const words = (char: string, pos = "VERB") => menu(char, pos).map((c) => c.reading + (c.okurigana ?? ""));
  // Sorted, because which of the two is listed first is KANJIDIC2's own
  // enumeration order and nothing this rule decides — 構 lists かま.える ahead
  // of かま.う and 震 lists ふる.う ahead of ふる.える.
  const classesFor = (char: string, reading: string, okurigana: string) =>
    menu(char)
      .filter((c) => c.reading === reading && c.okurigana === okurigana)
      .map((c) => c.conjClass)
      .sort();

  it("converts the reader's own case, and keeps the 四段 it is paired with", () => {
    // 伝ふ 下二段ハ行 beside 伝ふ 四段ハ行 — the ハ行 members of the same
    // 自他対応 alternation 立 and 破 are the タ行 and ラ行 members of.
    for (const char of ["伝", "傳"]) {
      expect(words(char)).not.toContain("つたえる");
      expect(classesFor(char, "つた", "ふ")).toEqual(["shimo-nidan-ha", undefined]);
    }
  });

  it("takes a curated classical reading as the same evidence", () => {
    // 與 is the one of the sixteen a reader meets, and its あた+ふ is not
    // KANJIDIC2's but `overrides.json`'s own entry for the character read as a
    // VERB — which is why the conversion runs over the assembled list rather
    // than inside the kun'yomi map. The curated entry stays offered (the
    // property below asks that of the whole table); what it has gained is a
    // sibling that carries 与ふ's paradigm, which a curated reading has no field
    // to state.
    for (const char of ["与", "與"]) {
      expect(words(char)).not.toContain("あたえる");
      expect(classesFor(char, "あた", "ふ")).toEqual(["shimo-nidan-ha", undefined]);
    }
  });

  it.each([
    ["構", "かま"],
    ["构", "かま"],
    ["事", "つか"],
    ["亊", "つか"],
    ["叓", "つか"],
    ["从", "したが"],
    ["調", "ととの"],
    ["添", "そ"],
    ["揃", "そろ"],
    ["震", "ふる"],
    ["浚", "さら"],
  ])("offers %s's %sえる as %sふ 下二段ハ行", (char, stem) => {
    expect(words(char)).not.toContain(stem + "える");
    expect(classesFor(char, stem, "ふ")).toEqual(["shimo-nidan-ha", undefined]);
  });

  it("leaves the rows where the 段 is in doubt, not just the 行", () => {
    // い/み/じ/ひ are excluded from `KAMI_NIDAN_SHUUSHI` for a different reason
    // from the あ row's, and a paired reading cannot answer it: what is in
    // doubt there is whether the word is 二段 at all. 交/混's ま.じる is 四段ラ行
    // 混じる and its ま.ぜる sibling is 下二段ザ行 混ず, so a rule reading the 行
    // off the sibling would have written まづ over a 四段 verb.
    for (const char of ["交", "混"]) {
      expect(words(char)).toContain("まじる");
      expect(classesFor(char, "ま", "じる")).toEqual([undefined]);
      expect(words(char)).toContain("まず");
    }
    // 上一段 in classical too, and keeping their る — see `LEXICAL_KUN` and the
    // み exclusion on `KAMI_NIDAN_SHUUSHI`.
    expect(words("用")).toContain("もちゐる");
    expect(words("試")).toContain("こころみる");
  });

  it("leaves an ending whose own 行 is already stated to the gate that declined it", () => {
    // 苦's くる.しめる is 下二段マ行 苦しむ and 浮's う.かべる 下二段バ行 浮かぶ —
    // the め and the べ state the 行 outright, and what stopped the conversion
    // is the length gate on `classicalConjClass`, not the あ row. This rule
    // fires on a bare える and so says nothing about them.
    expect(words("苦")).toContain("くるしめる");
    expect(words("浮")).toContain("うかべる");
  });

  it("leaves a modern える with no paired reading exactly as it was", () => {
    // 226 candidates on 211 characters, and neither other course is right for
    // them. Converting needs the 行, which by hypothesis nothing states; and
    // dropping would leave 89 of those 211 with no kun at all — 迎 is one of
    // them, its むか.える being the whole of its kun list. 考's かんが.え is a
    // nominalisation and 換's か.わる a different verb, which is why the test is
    // a paired 終止形 and not merely a same-reading neighbour.
    //
    // **絶 was the anchor here and has stopped being one**, and the premise it
    // was pinning is what changed rather than the rule: it never had a ふ or ゆ
    // sibling for this rule to read, and it now has a `VERB_LEXICON` sense of
    // its own (絶ゆ ヤ行下二段), which is precisely the evidence this rule's doc
    // names as the thing that closes one of the unpaired. So the menu reads
    // ぜつ / たユ / たやス / たツ, and **たえる is gone from it outright** — which
    // is intended and not a side effect: the menu offers the classical forms
    // this app prints, and a modern 下一段 ending is not one of them. That is
    // the same disappearance 易's やさシ makes of やさしい, and the same reason.
    expect(words("教")).toContain("おしえる");
    expect(words("迎")).toContain("むかえる");
    expect(words("絶")).not.toContain("たえる");
    expect(words("絶")).toContain("たゆ");
    expect(words("考")).toEqual(expect.arrayContaining(["かんがえる", "かんがえ"]));
    expect(words("換")).toEqual(expect.arrayContaining(["かえる", "かわる"]));
  });

  it("leaves no unconverted pair anywhere in the shipped index", () => {
    // The invariant rather than a list: after this rule no character's menu
    // carries a modern える beside a same-stem 終止形 in ふ or ゆ, at any part of
    // speech that lets an inflecting kun'yomi through.
    const bad: string[] = [];
    for (const char of Object.keys(kanjidic)) {
      for (const pos of ["VERB", "ADJ", "ADV", "PART", undefined]) {
        const candidates = candidateReadings(kanjidic, char, pos, undefined, jmdict);
        for (const c of candidates) {
          if (!c.okurigana?.endsWith("える")) continue;
          const prefix = c.okurigana.slice(0, -2);
          const paired = candidates.some(
            (o) => o !== c && o.reading === c.reading && (o.okurigana === prefix + "ふ" || o.okurigana === prefix + "ゆ"),
          );
          if (paired) bad.push(`${char} ${pos ?? "-"} ${c.reading}.${c.okurigana}`);
        }
      }
    }
    expect(bad.slice(0, 20).join(" ")).toBe("");
  });

  it("leaves every X.える/X.う pair in the shipped index standing at 下二段", () => {
    // Re-derived from KANJIDIC2's own kun lists each run rather than asserted
    // as a number. **19 characters** list one stem in both X.える and X.う,
    // which is the shape this rule reads, and every one of the 22 stems among
    // them ends up on a ふ with 下二段ハ行 beside it. Which route got it there
    // varies and is not this test's claim: 従/從's したが.える is already
    // answered by `attestedSenseByModernSpelling` off `VERB_LEXICON` (which
    // holds 従 and not its variant 从), 違/叶/整's by JMdict's classical
    // headwords through `attestedClassicalParadigm`, and the remaining 14
    // characters — 構/构, 事/亊/叓, 从, 調, 添, 揃, 震, 浚, 伝/傳 and 沗's two
    // stems — by this rule. 与/與, whose paired ふ is `overrides.json`'s rather
    // than KANJIDIC2's, are the other two it answers for and are checked above.
    const dotted = (char: string) => kanjidic[char].kun.map((k) => k.replace(/-/g, "")).filter((k) => k.includes("."));
    const paired: [string, string][] = [];
    for (const char of Object.keys(kanjidic)) {
      for (const k of dotted(char)) {
        const [stem, okurigana] = k.split(".");
        if (okurigana.endsWith("える") && dotted(char).includes(`${stem}.${okurigana.slice(0, -2)}う`)) {
          paired.push([char, stem]);
        }
      }
    }
    expect(new Set(paired.map(([char]) => char)).size).toBe(19);
    expect(paired).toHaveLength(22);
    const unconverted = paired.filter(([char, stem]) => !classesFor(char, stem, "ふ").includes("shimo-nidan-ha"));
    expect(unconverted.map(([char, stem]) => char + stem).join(" ")).toBe("");
    // 沗 is the one pairing this inherits rather than establishes: its entry
    // carries no meanings at all and its も.う is a reading no other character
    // in the index has, so whether も.える there is 燃ゆ (ヤ行, and もふ wrong)
    // cannot be settled from the entry. The annotation to correct is KANJIDIC2's
    // 沗 rather than this rule; the menu is asserted as it stands.
    expect(words("沗")).toEqual(["てん", "そふ", "そふ", "もふ", "もふ"]);
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
    //
    // `historicalSpelling` rather than a hand-rolled `index[char]?.[reading] ??
    // fullSizeKana(reading)`, and the difference is what this test caught: the
    // attested branch of that expression does not fold, so it drew 掛 as くゎ
    // where the menu had already gone over to くわ — the two paths disagreeing
    // about one character. The panel itself is folded by
    // `loadHistoricalKanaIndex`, which normalises the index's values on the way
    // in precisely because that file keeps a lookup of its own; this test loads
    // the raw JSON with `readFileSync` and so has to fold at the lookup to model
    // what the panel actually sees.
    const drawn = (char: string, reading: string) =>
      seriesAmbiguousReading(kanjidic, char, reading)
        ? fullSizeKana(reading)
        : historicalSpelling(historical, char, reading);
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

  it("offers the genuine-question reading of every particle that has one", () => {
    // The same claim as the one above, of the table beside it: a particle with
    // two readings has both of them on the page — `sentenceFinalParticleFor`
    // writes the か inside a 豈 clause — so the menu has to be able to name
    // both. Asked of the whole table rather than of 乎/與/与 by name, because
    // this is the invariant and the table is meant to grow.
    const missing = [...GENUINE_QUESTION_PARTICLE_LEMMAS]
      .filter((lemma) => !offered(lemma).includes(genuineQuestionParticle(lemma) ?? ""))
      .map((lemma) => `${lemma}=${genuineQuestionParticle(lemma)}`);
    expect(missing).toEqual([]);
  });

  it("offers 與 both of its readings, and 乎 its か exactly once", () => {
    // 與 is the character the reader asked for — "矣 is silent, but 與 should
    // have か as a possible reading" — and the point is *both*: や stays the
    // default (`SENTENCE_FINAL_PARTICLES`) and か stands beside it as the
    // alternative, so a reader who wants the plain interrogative can pick it
    // and a reader looking at the default や sees it marked as current.
    for (const char of ["與", "与"]) {
      expect(offered(char)).toContain("や");
      expect(offered(char)).toContain("か");
    }
    // 乎 gains nothing here and must not gain a second entry: KANJIDIC2 lists
    // か among its own kun readings and `overrides.json` states it again on a
    // char-only entry, both ahead of this arm, so the new one folds into them
    // by the de-duplication in `candidateReadings`. A
    // menu listing か twice over one character would be worse than the missing
    // entry this arm was added for. Same shape, same reason, as the
    // auxiliaries' "exactly once, whatever else names it" above.
    for (const pos of EVERY_POS) {
      expect(candidateReadings(kanjidic, "乎", pos, historical, jmdict).filter((c) => c.reading === "か")).toHaveLength(1);
      expect(candidateReadings(kanjidic, "與", pos, historical, jmdict).filter((c) => c.reading === "か")).toHaveLength(1);
    }
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
    for (const lemma of GENUINE_QUESTION_PARTICLE_LEMMAS) {
      const genuine = genuineQuestionParticle(lemma);
      if (genuine) curated.push([lemma, genuine]);
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

describe("an 音便 stem takes no transfer — 於 is おいて, never おひて", () => {
  // The reader's own question, and it is a question about where an い came
  // from. 於 is read with the カ行四段 おく: おき + て, イ音便, おいて — and
  // 歴史的仮名遣い writes a 音便 as it sounds (書きて -> 書いて, never 書ひて).
  // おひて would be the historical spelling of a ハ行 verb, 追ひて or 生ひて,
  // which is a different word. See `onbinStemReading`.
  const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "data");
  const kanjidic = JSON.parse(readFileSync(join(DATA_DIR, "kanjidic-index.json"), "utf-8")) as KanjidicIndex;
  const jmdict = JSON.parse(readFileSync(join(DATA_DIR, "jmdict-index.json"), "utf-8")) as JmdictIndex;
  const historical = JSON.parse(readFileSync(join(DATA_DIR, "historical-kana-index.json"), "utf-8")) as HistoricalKanaIndex;

  it("is the reading-keyed transfer that had to be stopped, not a literal", () => {
    resetReadingTable();
    // The transfer table's answer for おい is unanimous and it is おひ,
    // contributed by 生, 負 and 笈 — every one a genuine ハ行 stem. Nothing is
    // wrong with that answer; it is the wrong word's answer for 於, whose own
    // index entry ({"お": "を"}) does not cover おい and so left the field to it.
    expect(historicalByReading(historical, [], "おい")).toBe("おひ");
    expect(historical["於"]).toEqual({ お: "を" });
    expect(kanjidic["於"].kun).toContain("おい.て");
  });

  it("offers 於 no おひ in the furigana menu", () => {
    resetReadingTable();
    const offered = candidateReadings(kanjidic, "於", "ADP", historical, jmdict).map(
      (c) => c.reading + (c.okurigana ?? ""),
    );
    expect(offered).not.toContain("おひて");
    expect(offered).toContain("おいて");
  });

  it("draws 於 no おひ through lookupKanji either", () => {
    resetReadingTable();
    // The second route to the page, and the one `yuParts` does not intercept:
    // the resolver keys on the token's text where `yuParts` keys on its lemma,
    // so a 於 inside a compound span reaches this instead.
    expect(lookupKanji(kanjidic, "於", undefined, undefined, historical)?.reading).not.toContain("おひ");
  });

  it("stops 序's つひ for the same reason, and touches nothing else", () => {
    resetReadingTable();
    // The only other kun in the whole shipped index that was taking a wrong
    // transfer. ついで is 次ぐ's 連用形 次ぎ + て — イ音便 again — where つひ is
    // 終/遂, a different word.
    expect(historicalByReading(historical, [], "つい")).toBe("つひ");
    expect(candidateReadings(kanjidic, "序", "NOUN", historical, jmdict).map((c) => c.reading)).not.toContain("つひ");
    // 以's もっ.て has the same shape and its own attestation, which still
    // answers first: 促音便 written full-size, もつて.
    expect(historical["以"]?.["もっ"]).toBe("もつ");
    expect(candidateReadings(kanjidic, "以", "ADP", historical, jmdict).map((c) => c.reading)).toContain("もつ");
  });
});

// ---------------------------------------------------------------------------
// 歴史的仮名遣い has no 小書き仮名. This is that rule as a property over the
// whole shipped data rather than over a handful of characters, because the
// leak that prompted it (輒 offering ちょう) was one of 1,132 waiting on 1,008
// characters for a text that used them.
// ---------------------------------------------------------------------------

describe("no reading the app can produce contains small kana", () => {
  const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "data");
  const kanjidic = JSON.parse(readFileSync(join(DATA_DIR, "kanjidic-index.json"), "utf-8")) as KanjidicIndex;
  const jmdict = JSON.parse(readFileSync(join(DATA_DIR, "jmdict-index.json"), "utf-8")) as JmdictIndex;
  const rawHistorical = JSON.parse(readFileSync(join(DATA_DIR, "historical-kana-index.json"), "utf-8")) as HistoricalKanaIndex;
  /** What `loadHistoricalKanaIndex` hands the app: the same file with its
   * values folded. Read with `readFileSync` here, so the fold has to be
   * repeated — see that function for why the data is normalised on the way in
   * as well as at every lookup. */
  const historical: HistoricalKanaIndex = Object.fromEntries(
    Object.entries(rawHistorical).map(([char, readings]) => [
      char,
      Object.fromEntries(Object.entries(readings).map(([modern, hist]) => [modern, fullSizeKana(hist)])),
    ]),
  );

  const SMALL_KANA = /[ぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮ]/u;
  const offending = (strings: (string | undefined)[]): string[] => strings.filter((s): s is string => !!s && SMALL_KANA.test(s));

  it("holds for every candidate the readings menu offers, on every character in KANJIDIC", () => {
    // The menu is where 輒 was caught, and it is the widest surface: every
    // character the app can be shown, at every POS that changes what `pickKun`
    // returns. A fixture would have needed 輒 in it to find 輒.
    const bad: string[] = [];
    for (const char of Object.keys(kanjidic)) {
      for (const pos of [undefined, "VERB", "NOUN", "PROPN", "ADV"]) {
        for (const c of candidateReadings(kanjidic, char, pos, historical, jmdict)) {
          for (const piece of offending([c.reading, c.okurigana])) bad.push(`${char}/${pos ?? "-"}=${piece}`);
        }
      }
    }
    // Joined rather than compared as an array: a failing list of 1,132 is
    // truncated to nothing useful in the diff, and the character that leaked
    // is the whole of what a reader of this failure needs.
    expect(bad.slice(0, 20).join(" ")).toBe("");
  });

  it("holds for every reading the panels draw through lookupKanji", () => {
    // The other route to the page: the resolver keys on the token's text where
    // the menu keys on the character, and a fold applied to one and not the
    // other is exactly the shape of the fault this rule is about.
    const bad: string[] = [];
    for (const char of Object.keys(kanjidic)) {
      for (const pos of [undefined, "VERB", "NOUN"]) {
        const hit = lookupKanji(kanjidic, char, pos, undefined, historical);
        for (const piece of offending([hit?.reading, hit?.okurigana])) bad.push(`${char}/${pos ?? "-"}=${piece}`);
      }
    }
    // Joined rather than compared as an array: a failing list of 1,132 is
    // truncated to nothing useful in the diff, and the character that leaked
    // is the whole of what a reader of this failure needs.
    expect(bad.slice(0, 20).join(" ")).toBe("");
  });

  it("holds for the shipped historical-kana index itself, once loaded", () => {
    // 27 of its values on 21 characters arrive with a small ゎ — Wiktionary
    // writes 合拗音 くゎう where this app writes くわう, and the same file
    // already carries 郭's くわく in the app's own convention. Attested is not
    // the same as written the way this app writes things.
    const raw = Object.entries(rawHistorical).flatMap(([char, rs]) =>
      Object.entries(rs).filter(([, h]) => SMALL_KANA.test(h)).map(([m, h]) => `${char}:${m}=${h}`),
    );
    expect(raw.length).toBeGreaterThan(0);
    const loaded = Object.entries(historical).flatMap(([char, rs]) =>
      Object.entries(rs).filter(([, h]) => SMALL_KANA.test(h)).map(([m, h]) => `${char}:${m}=${h}`),
    );
    expect(loaded).toEqual([]);
  });

  it("holds for every curated reading and the verb lexicon", () => {
    // Both are hand-written and both are clean today; asserted so that a new
    // entry cannot quietly be written in the modern convention.
    const curated = (overridesData as { char: string; reading?: string; okurigana?: string }[]).flatMap((e) =>
      offending([e.reading, e.okurigana]).map((p) => `${e.char}=${p}`),
    );
    expect(curated).toEqual([]);
    // The verb lexicon is asserted **as drawn**, not at rest, and the
    // difference is deliberate: 39 of its entries hold a modern reading by
    // design — the ones whose extraction found no classical table (仰 おっしゃ,
    // 則 のっと, 尤 もっと, 表 ひょう) — and `fullSizeKana` is documented as the
    // thing that corrects them on the way to the page. What must be clean is
    // the string the panel draws, which is what `lexiconFurigana` produces.
    const atRest = Object.entries(LEXICON_SENSES).flatMap(([char, senses]) =>
      senses.flatMap((s) => offending([s.reading]).map((p) => `${char}=${p}`)),
    );
    expect(atRest.length).toBeGreaterThan(0);
    const drawn = Object.entries(LEXICON_SENSES).flatMap(([char, senses]) =>
      senses.flatMap((s) =>
        !s.reading || [...char].length !== 1
          ? []
          : offending([
              seriesAmbiguousReading(kanjidic, char, s.reading)
                ? fullSizeKana(s.reading)
                : historicalSpelling(historical, char, s.reading),
            ]).map((p) => `${char}=${p}`),
      ),
    );
    expect(drawn).toEqual([]);
  });

  it("folds every small kana it knows of, so the rule has no hole to fall through", () => {
    // The invariant stated over the function rather than over the data: the
    // fold's table has to cover the whole 小書き block, or a character outside
    // it is a leak the sweeps above only catch once some index happens to
    // carry it. っ and ゎ were both missing when this was written — the first
    // from the う exception, the second from the table.
    const smallKana = [..."ぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮ"];
    expect(offending(smallKana.map((k) => fullSizeKana(k)))).toEqual([]);
    expect(offending(smallKana.map((k) => fullSizeKana(`き${k}う`)))).toEqual([]);
  });
});
