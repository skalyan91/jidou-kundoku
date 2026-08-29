import { describe, expect, it } from "vitest";
import type { Sentence, Token } from "../src/parse/types.ts";
import {
  caseParticleFor,
  conjugatedOkurigana,
  syntheticLexiconEntry,
  decideConjForm,
  extraEndingFor,
  genitiveNoParticle,
  ziReading,
} from "../src/kakikudashi/conjugationContext.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type KanjidicIndex } from "../src/reading/kanjidicLookup.ts";
import { type JmdictIndex, lookupLemma, lookupModernisedLemma, shinjitaiSpelling } from "../src/reading/jmdictLookup.ts";
import { createReadingResolver } from "../src/reading/readingResolver.ts";
import { conjugate } from "../src/kakikudashi/classicalConjugation.ts";
import {
  duplicateSuffixShapes,
  EXTRA_SUFFIX_OF,
  missingParadigmEntries,
  PARADIGMS_PATH,
  SUFFIX_OF,
} from "../scripts/build-verb-lexicon.mjs";
import { LEXICON_SENSES, lexiconSensesByReading, VERB_LEXICON } from "../src/kakikudashi/verbLexicon.ts";

const DATA_DIR = join(process.cwd(), "public", "data");
const loadIndex = <T,>(file: string): T => JSON.parse(readFileSync(join(DATA_DIR, file), "utf-8")) as T;
const kanjidic = loadIndex<KanjidicIndex>("kanjidic-index.json");
const jmdict = loadIndex<JmdictIndex>("jmdict-index.json");
const historicalKana = loadIndex<Record<string, Record<string, string>>>("historical-kana-index.json");
const resolve = createReadingResolver(kanjidic, jmdict, historicalKana);

function makeToken(overrides: Partial<Token>): Token {
  return { id: 0, text: "", lemma: "", pos: "", xpos: "", dep: "", head: 0, ...overrides };
}

describe("ziReading", () => {
  it("defaults to し (master/teacher) when 子 has no possessive modifier", () => {
    const token = makeToken({ id: 0, text: "子", dep: "ROOT", head: 0 });
    const sentence: Sentence = { tokens: [token] };
    expect(ziReading(token, sentence)).toBe("し");
  });

  it("reads こ (child) when 子 has a possessive/determiner modifier (its子, 吾子, etc.)", () => {
    const token = makeToken({ id: 1, text: "子", dep: "comp:obj", head: 2 });
    const possessive = makeToken({ id: 0, text: "其", dep: "det", head: 1 });
    const sentence: Sentence = { tokens: [possessive, token] };
    expect(ziReading(token, sentence)).toBe("こ");
  });

  it("returns undefined for any character other than 子", () => {
    const token = makeToken({ id: 0, text: "君", dep: "ROOT", head: 0 });
    const sentence: Sentence = { tokens: [token] };
    expect(ziReading(token, sentence)).toBeUndefined();
  });
});

describe("a clause headed by a particle", () => {
  /** 黃帝者、少典之子。 as the parser returns it: 者 heads the clause and the
   * nominal predicate hangs off it as `conj:coord`. The closing 。 is what
   * licenses the copula at all — see `isPredicationLicensed`, exercised on
   * its own below. */
  const particleHeaded = (predicatePos = "NOUN"): Sentence => ({
    tokens: [
      makeToken({ id: 0, text: "帝", lemma: "帝", pos: "NOUN", dep: "mod", head: 1 }),
      makeToken({ id: 1, text: "者", lemma: "者", pos: "PART", dep: "ROOT", head: 1 }),
      makeToken({ id: 2, text: "子", lemma: "子", pos: predicatePos, dep: "conj:coord", head: 1 }),
      makeToken({ id: 3, text: "。", lemma: "。", pos: "PUNCT", dep: "punct", head: 1 }),
    ],
  });

  it("gives the predicate なり, not the do-verb", () => {
    // 者 marks what the clause is about and predicates nothing itself, so
    // the nominal hanging off it is the predicate: 黃帝 *is* the son of
    // Shaodian, rather than doing anything.
    const s = particleHeaded();
    expect(extraEndingFor(s.tokens[2], s.tokens[1], s)?.primary).toBe("なり");
  });

  it("still reaches for the do-verb under a non-particle head", () => {
    const s: Sentence = {
      tokens: [
        makeToken({ id: 0, text: "學", lemma: "學", pos: "VERB", dep: "ROOT", head: 0 }),
        makeToken({ id: 1, text: "禮", lemma: "禮", pos: "NOUN", dep: "conj:coord", head: 0 }),
      ],
    };
    expect(extraEndingFor(s.tokens[1], s.tokens[0], s)?.primary).toBe("す");
  });

  it("leaves a verbal predicate alone either way", () => {
    const s = particleHeaded("VERB");
    expect(extraEndingFor(s.tokens[2], s.tokens[1], s)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// の on a name that modifies a following nominal. Every tree below is the one
// the live parser returns for the text named in its comment.
// ---------------------------------------------------------------------------

describe("genitiveNoParticle", () => {
  /** 楚人至。 — a state name over the common noun it names. */
  const chuRen: Sentence = {
    tokens: [
      makeToken({ id: 0, text: "楚", lemma: "楚", pos: "PROPN", dep: "mod", head: 1, morph: "Case=Loc|NameType=Nat" }),
      makeToken({ id: 1, text: "人", lemma: "人", pos: "NOUN", dep: "subj", head: 2 }),
      makeToken({ id: 2, text: "至", lemma: "至", pos: "VERB", dep: "ROOT", head: 2 }),
    ],
  };

  it("marks a PROPN modifying a following noun", () => {
    expect(genitiveNoParticle(chuRen.tokens[0], chuRen)).toBe("の");
  });

  it("wins over the fronted-topic は the same token would otherwise attract", () => {
    // 楚 is a `mod` carrying Case=Loc whose governor is the sentence's subj,
    // which is exactly pattern b's signature in `caseParticleFor` — it was
    // coming out 楚は人至る.
    expect(caseParticleFor(chuRen.tokens[0], chuRen)).toBe("の");
  });

  it("gives a common noun modifying a common noun the particle too", () => {
    // 先帝之臣: 先 arrives as NOUN+`mod` over 帝, the identical edge 楚 has
    // over 人 — and it takes the の as well. This asserted the opposite while
    // the rule was restricted to a PROPN modifier, on the grounds that such a
    // pair is often a fused jukugo (先帝 せんてい). Withholding the particle
    // did not read those as jukugo, though: it handed them to the
    // fronted-topic rule, and 山中有虎 came out 山は中虎を有り.
    //
    // The cost is real and has no structural remedy — 冰水為之's 冰 arrives on
    // exactly this edge and is a topic, so it now reads 冰の水 where the
    // published reading is 冰は水 (see the generator test of that line).
    // Telling the two apart needs lexical evidence, not a POS.
    const s: Sentence = {
      tokens: [
        makeToken({ id: 0, text: "先", lemma: "先", pos: "NOUN", dep: "mod", head: 1, morph: "Case=Loc" }),
        makeToken({ id: 1, text: "帝", lemma: "帝", pos: "NOUN", dep: "comp:obj", head: 2 }),
        makeToken({ id: 2, text: "之", lemma: "之", pos: "SCONJ", dep: "mod", head: 3 }),
        makeToken({ id: 3, text: "臣", lemma: "臣", pos: "NOUN", dep: "ROOT", head: 3 }),
      ],
    };
    expect(genitiveNoParticle(s.tokens[0], s)).toBe("の");
  });

  /** 梁惠王曰。 — 梁 modifies 王 across 惠, which is fused into the name. */
  const liangHuiWang: Sentence = {
    tokens: [
      makeToken({ id: 0, text: "梁", lemma: "梁", pos: "PROPN", dep: "mod", head: 2, morph: "Case=Loc|NameType=Nat" }),
      makeToken({ id: 1, text: "惠", lemma: "惠", pos: "PROPN", dep: "compound", head: 2, morph: "NameType=Prs" }),
      makeToken({ id: 2, text: "王", lemma: "王", pos: "NOUN", dep: "subj", head: 3 }),
      makeToken({ id: 3, text: "曰", lemma: "曰", pos: "VERB", dep: "ROOT", head: 3 }),
    ],
  };

  it("reaches past the head's own fused name-mates — 梁の惠王", () => {
    expect(genitiveNoParticle(liangHuiWang.tokens[0], liangHuiWang)).toBe("の");
  });

  it("leaves those name-mates themselves alone — 惠王 is one name", () => {
    expect(genitiveNoParticle(liangHuiWang.tokens[1], liangHuiWang)).toBeUndefined();
  });

  it("marks a state name the parser labelled `compound` — 秦の王", () => {
    // 秦王/楚王/齊王/趙王 all come back `compound`, where the same states over
    // 人/兵 come back `mod`. NameType=Nat is what says this one is still a
    // state and not half of a personal name.
    const s: Sentence = {
      tokens: [
        makeToken({ id: 0, text: "秦", lemma: "秦", pos: "PROPN", dep: "compound", head: 1, morph: "Case=Loc|NameType=Nat" }),
        makeToken({ id: 1, text: "王", lemma: "王", pos: "NOUN", dep: "ROOT", head: 1 }),
      ],
    };
    expect(genitiveNoParticle(s.tokens[0], s)).toBe("の");
  });

  it("leaves a personal name's own `compound` fused — 黃帝, not 黃の帝", () => {
    const s: Sentence = {
      tokens: [
        makeToken({ id: 0, text: "黃", lemma: "黃", pos: "PROPN", dep: "compound", head: 1, morph: "NameType=Giv" }),
        makeToken({ id: 1, text: "帝", lemma: "帝", pos: "NOUN", dep: "ROOT", head: 1 }),
      ],
    };
    expect(genitiveNoParticle(s.tokens[0], s)).toBeUndefined();
  });

  it("needs a nominal head — a `mod` flung across a clause onto 者 is not one", () => {
    // 楚人有鬻盾與矛者: 盾 is tagged PROPN and `mod`, three tokens away from
    // the 者 it attaches to.
    const s: Sentence = {
      tokens: [
        makeToken({ id: 0, text: "盾", lemma: "盾", pos: "PROPN", dep: "mod", head: 3, morph: "NameType=Giv" }),
        makeToken({ id: 1, text: "與", lemma: "與", pos: "ADP", dep: "cc", head: 2 }),
        makeToken({ id: 2, text: "矛", lemma: "矛", pos: "NOUN", dep: "conj:coord", head: 0 }),
        makeToken({ id: 3, text: "者", lemma: "者", pos: "PART", dep: "ROOT", head: 3 }),
      ],
    };
    expect(genitiveNoParticle(s.tokens[0], s)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// What licenses a synthesized sentence-final ending, and which one it is.
// ---------------------------------------------------------------------------

describe("the synthesized copula needs the source to have closed the sentence", () => {
  /** 君子, with whatever the caller wants after it. */
  const junzi = (...after: Token[]): Sentence => ({
    tokens: [makeToken({ id: 0, text: "君子", lemma: "君子", pos: "NOUN", dep: "ROOT", head: 0 }), ...after],
  });

  it("withholds なり from a bare noun the source left unpunctuated", () => {
    const s = junzi();
    expect(extraEndingFor(s.tokens[0], s.tokens[0], s)).toBeNull();
  });

  it("supplies it once a full stop closes the sentence", () => {
    const s = junzi(makeToken({ id: 1, text: "。", lemma: "。", pos: "PUNCT", dep: "punct", head: 0 }));
    expect(extraEndingFor(s.tokens[0], s.tokens[0], s)?.primary).toBe("なり");
  });

  it("takes a sentence-final particle as the same signal — 君子乎", () => {
    const s = junzi(makeToken({ id: 1, text: "乎", lemma: "乎", pos: "PART", dep: "discourse@sp", head: 0 }));
    expect(extraEndingFor(s.tokens[0], s.tokens[0], s)?.primary).toBe("なり");
  });

  it("takes a negation over the root too, which has nothing to inflect without it", () => {
    // 不亦君子 — the ず is emitted whatever happens here, so withholding the
    // copula would leave 亦君子ず rather than a bare noun phrase.
    const s: Sentence = {
      tokens: [
        makeToken({ id: 0, text: "不", lemma: "不", pos: "ADV", dep: "mod", head: 1, morph: "Polarity=Neg" }),
        makeToken({ id: 1, text: "君子", lemma: "君子", pos: "NOUN", dep: "ROOT", head: 1 }),
      ],
    };
    expect(extraEndingFor(s.tokens[1], s.tokens[1], s)?.primary).toBe("なり");
  });

  it("withholds the particle-headed clause's copula on the same grounds", () => {
    // 黃帝者、少典之子 with no closing mark — the same inference reached
    // through 者 instead of through the nominal itself.
    const s: Sentence = {
      tokens: [
        makeToken({ id: 0, text: "者", lemma: "者", pos: "PART", dep: "ROOT", head: 0 }),
        makeToken({ id: 1, text: "子", lemma: "子", pos: "NOUN", dep: "conj:coord", head: 0 }),
      ],
    };
    expect(extraEndingFor(s.tokens[1], s.tokens[0], s)).toBeNull();
  });

  it("leaves the do-verb alone — a noun used verbally is not a sentence ending in a noun", () => {
    const s: Sentence = {
      tokens: [
        makeToken({ id: 0, text: "生", lemma: "生", pos: "VERB", dep: "ROOT", head: 0 }),
        makeToken({ id: 1, text: "神靈", lemma: "神靈", pos: "NOUN", dep: "conj:coord", head: 0 }),
      ],
    };
    expect(extraEndingFor(s.tokens[1], s.tokens[0], s)?.primary).toBe("す");
  });
});

describe("あり, not なり, for a predicate that states a quantity", () => {
  /** 弟子三千人。 as the parser returns it: the numeral is the root, the
   * counted noun its `subj`, the classifier its `clf`. */
  const disciples: Sentence = {
    tokens: [
      makeToken({ id: 0, text: "弟子", lemma: "弟子", pos: "NOUN", dep: "subj", head: 1 }),
      makeToken({ id: 1, text: "三千", lemma: "三千", pos: "NUM", dep: "ROOT", head: 1 }),
      makeToken({ id: 2, text: "人", lemma: "人", pos: "NOUN", dep: "clf", head: 1, morph: "NounType=Clf" }),
      makeToken({ id: 3, text: "。", lemma: "。", pos: "PUNCT", dep: "punct", head: 1 }),
    ],
  };

  it("hangs あり off the classifier, which is read last — 弟子三千人あり", () => {
    expect(extraEndingFor(disciples.tokens[2], disciples.tokens[1], disciples)?.primary).toBe("あり");
  });

  it("leaves the numeral itself bare, so the ending lands after the count and not inside it", () => {
    // Emitting on the root gave 弟子三千あり人.
    expect(extraEndingFor(disciples.tokens[1], disciples.tokens[1], disciples)).toBeNull();
  });

  it("hangs it off the numeral where there is no classifier — 兵十萬あり", () => {
    const s: Sentence = {
      tokens: [
        makeToken({ id: 0, text: "兵", lemma: "兵", pos: "NOUN", dep: "subj", head: 1 }),
        makeToken({ id: 1, text: "十萬", lemma: "十萬", pos: "NUM", dep: "ROOT", head: 1 }),
        makeToken({ id: 2, text: "。", lemma: "。", pos: "PUNCT", dep: "punct", head: 1 }),
      ],
    };
    expect(extraEndingFor(s.tokens[1], s.tokens[1], s)?.primary).toBe("あり");
  });

  it("takes a numeral modifying the nominal root as the same predication — 一妻あり", () => {
    const s: Sentence = {
      tokens: [
        makeToken({ id: 0, text: "一", lemma: "一", pos: "NUM", dep: "mod", head: 1 }),
        makeToken({ id: 1, text: "妻", lemma: "妻", pos: "NOUN", dep: "ROOT", head: 1 }),
        makeToken({ id: 2, text: "。", lemma: "。", pos: "PUNCT", dep: "punct", head: 1 }),
      ],
    };
    expect(extraEndingFor(s.tokens[1], s.tokens[1], s)?.primary).toBe("あり");
  });

  it("ignores a numeral that isn't counting the predicate — 三人行。", () => {
    const s: Sentence = {
      tokens: [
        makeToken({ id: 0, text: "三", lemma: "三", pos: "NUM", dep: "mod", head: 1 }),
        makeToken({ id: 1, text: "人", lemma: "人", pos: "NOUN", dep: "subj", head: 2 }),
        makeToken({ id: 2, text: "行", lemma: "行", pos: "VERB", dep: "ROOT", head: 2 }),
        makeToken({ id: 3, text: "。", lemma: "。", pos: "PUNCT", dep: "punct", head: 2 }),
      ],
    };
    expect(extraEndingFor(s.tokens[2], s.tokens[2], s)).toBeNull();
    expect(extraEndingFor(s.tokens[1], s.tokens[2], s)).toBeNull();
  });

  it("is gated by the same licence なり is — an unpunctuated count is a noun phrase", () => {
    const unmarked: Sentence = { tokens: disciples.tokens.filter((t) => t.dep !== "punct") };
    expect(extraEndingFor(unmarked.tokens[2], unmarked.tokens[1], unmarked)).toBeNull();
  });
});

describe("毎 puts the verb it quantifies into 連体形", () => {
  /** 毎得書讀之。 — 毎 attaches to 得, and 讀 is tagged `parataxis` onto it. */
  const everyTime: Sentence = {
    tokens: [
      makeToken({ id: 0, text: "毎", lemma: "每", pos: "ADV", dep: "mod", head: 1, morph: "Degree=Pos|VerbForm=Conv" }),
      makeToken({ id: 1, text: "得", lemma: "得", pos: "VERB", dep: "ROOT", head: 1 }),
      makeToken({ id: 2, text: "書", lemma: "書", pos: "NOUN", dep: "comp:obj", head: 1 }),
      makeToken({ id: 3, text: "讀", lemma: "讀", pos: "VERB", dep: "parataxis", head: 1 }),
    ],
  };

  it("gives 得 rentai, not shuushi — 書を得るごとに", () => {
    expect(decideConjForm(everyTime.tokens[1], everyTime.tokens[2], everyTime, "shimo-nidan-a")).toBe("rentai");
  });

  it("outranks the coordination chain 讀 would otherwise put 得 in 連用形 for", () => {
    const withoutMei: Sentence = { tokens: everyTime.tokens.filter((t) => t.lemma !== "每") };
    expect(decideConjForm(withoutMei.tokens[0], withoutMei.tokens[1], withoutMei, "shimo-nidan-a")).toBe("renyou");
  });

  it("leaves a verb with no 毎 of its own alone", () => {
    expect(decideConjForm(everyTime.tokens[3], undefined, everyTime, "yodan-ma")).toBe("shuushi");
  });
});

// ---------------------------------------------------------------------------
// The 二段 paradigm rows themselves. 下二段 was missing every consonant row
// but ア行 (得), so a verb selected into one of them had nothing to conjugate
// with; 上二段 had only カ行 and マ行.
// ---------------------------------------------------------------------------

describe("二段 paradigms", () => {
  it("gives 下二段タ行 an e-sound mizen/renyou, which is the whole point of the class", () => {
    // The transitive 立: 立て before て or ず, 立つ in 終止形. A 四段 reading
    // of the same 終止形 would give 立ち/立た instead, which is the
    // intransitive word.
    expect(conjugate("shimo-nidan-ta", "mizen")).toBe("て");
    expect(conjugate("shimo-nidan-ta", "renyou")).toBe("て");
    expect(conjugate("shimo-nidan-ta", "shuushi")).toBe("つ");
    expect(conjugate("shimo-nidan-ta", "rentai")).toBe("つる");
    expect(conjugate("shimo-nidan-ta", "izen")).toBe("つれ");
    expect(conjugate("shimo-nidan-ta", "meirei")).toBe("てよ");
  });

  it("writes 下二段ハ行 in 歴史的仮名遣い (與ふ, not 與う)", () => {
    expect(conjugate("shimo-nidan-ha", "renyou")).toBe("へ");
    expect(conjugate("shimo-nidan-ha", "shuushi")).toBe("ふ");
    expect(conjugate("shimo-nidan-ha", "rentai")).toBe("ふる");
  });

  it("keeps 下二段ア行 (得) the consonant-less special case it was", () => {
    // 得ず/得/得るる — the kanji's own reading already covers the mora every
    // other row writes out as okurigana, so mizen/renyou/shuushi stay empty.
    expect(conjugate("shimo-nidan-a", "renyou")).toBe("");
    expect(conjugate("shimo-nidan-a", "shuushi")).toBe("");
    expect(conjugate("shimo-nidan-a", "rentai")).toBe("る");
  });

  it("gives 上二段 an i-sound mizen/renyou across the rows it now covers", () => {
    expect(conjugate("kami-nidan-ba", "renyou")).toBe("び"); // 亡ぶ
    expect(conjugate("kami-nidan-ta", "renyou")).toBe("ち"); // 落つ
    expect(conjugate("kami-nidan-ga", "rentai")).toBe("ぐる"); // 過ぐ
    expect(conjugate("kami-nidan-ra", "meirei")).toBe("りよ"); // 懲る
  });
});

// ---------------------------------------------------------------------------
// The multi-sense lexicon. `verb-lexicon-index.json` carries every classical
// sense the build script could classify for a kanji rather than only the
// first, and `syntheticLexiconEntry` picks among them by the reading the
// syntax chose. 肥 is the pair that motivated it: こやす (四段サ行) and こゆ
// (下二段ヤ行) share a lemma and a reading, and only the okurigana separates
// them.
// ---------------------------------------------------------------------------

describe("LEXICON_SENSES / lexiconSensesByReading", () => {
  it("keeps every classified sense for a kanji, the single-entry winner first", () => {
    const senses = LEXICON_SENSES["肥"];
    expect(senses.length).toBeGreaterThan(1);
    expect(senses[0]).toEqual(VERB_LEXICON["肥"]);
    expect(senses.map((s) => s.conjClass)).toContain("shimo-nidan-ya");
  });

  it("still exposes exactly one entry per lemma through VERB_LEXICON", () => {
    // Nothing that doesn't select by reading should be able to tell that the
    // index changed shape — this is the guarantee the build script preserves
    // by appending in scan order.
    expect(VERB_LEXICON["肥"]).toEqual({ conjClass: "yodan-sa", okuriganaPrefix: "や", reading: "こ" });
    expect(VERB_LEXICON["學"]).toEqual({ conjClass: "yodan-ba", reading: "まな" });
  });

  it("returns every sense sharing a reading, not the first of them", () => {
    const both = lexiconSensesByReading("肥", "こ");
    expect(both.map((s) => s.conjClass).sort()).toEqual(["shimo-nidan-ya", "yodan-sa"]);
  });

  it("returns nothing for an unknown lemma, an unknown reading, or no reading", () => {
    expect(lexiconSensesByReading("肥", "ふと")).toEqual([]);
    expect(lexiconSensesByReading("々", "こ")).toEqual([]);
    expect(lexiconSensesByReading("肥", undefined)).toEqual([]);
  });

  it("puts a RESIDUAL entry in front of the derived senses it corrects", () => {
    // 說's only Wiktionary entry is 説く "to explain", a different word from
    // the よろこばし this app needs — so the hand-supplied entry leads, and
    // `VERB_LEXICON` is unchanged, while 説く stays reachable by its own
    // reading rather than being discarded.
    expect(LEXICON_SENSES["說"][0]).toEqual(VERB_LEXICON["說"]);
    expect(VERB_LEXICON["說"].conjClass).toBe("shiku-keiyoushi");
  });
});

describe("syntheticLexiconEntry", () => {
  it("takes the attested sense whose modern okurigana is the one the resolver produced", () => {
    // 肥, both ways. The resolver reaches no class for either (neither える
    // nor やす is a shape `classicalConjClass` will read one off), so the
    // lexicon decides alone — and decides differently for the two, which is
    // the whole point.
    expect(syntheticLexiconEntry({ reading: "こ", okurigana: "える" }, "肥")).toEqual({
      conjClass: "shimo-nidan-ya",
      reading: "こ",
    });
    expect(syntheticLexiconEntry({ reading: "こ", okurigana: "やす" }, "肥")).toEqual({
      conjClass: "yodan-sa",
      okuriganaPrefix: "や",
      reading: "こ",
    });
  });

  it("never overrules a class the mechanical derivation did reach", () => {
    // 立's attested senses are both 四段; the transitive reading 立てる gives
    // 下二段タ行, which disagrees with each of them, so the derivation stands
    // and 廟を立てて is unaffected. The intransitive one agrees, and the entry
    // is the same either way.
    expect(syntheticLexiconEntry({ conjClass: "shimo-nidan-ta", reading: "た", okurigana: "つ" }, "立")).toEqual({
      conjClass: "shimo-nidan-ta",
      reading: "た",
    });
    expect(syntheticLexiconEntry({ conjClass: "yodan-ta", reading: "た", okurigana: "つ" }, "立")).toEqual({
      conjClass: "yodan-ta",
      reading: "た",
    });
  });

  it("claims nothing where no attested sense spells itself the way the reading does", () => {
    // 哀 is read あわ+れむ by KANJIDIC2 and あはれ+む by Wiktionary — the same
    // word split at a different okurigana boundary, so the two spellings
    // disagree and the sense is not taken. Without this check the character
    // came back 哀む.
    expect(syntheticLexiconEntry({ reading: "あわ", okurigana: "れむ" }, "哀")).toBeUndefined();
    // And with no class of its own to fall back on, nothing at all — the
    // caller then behaves exactly as it did before any of this existed.
    expect(syntheticLexiconEntry({ reading: "こ", okurigana: "えます" }, "肥")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The build script's own table guards. `SUFFIX_OF` and `PARADIGMS` are written
// out separately and nothing in the type system ties them together — the index
// is a JSON import, so the `conjClass` strings it carries are asserted to be
// `ConjClass`, never checked. Adding ヤ行下二段 to one and forgetting the other
// gave a clean `tsc`, a clean build, and `conjugate` throwing on undefined at
// render time. These assert the guard that now catches it, and assert it by
// making it fire rather than only by watching it stay quiet.
// ---------------------------------------------------------------------------

describe("build-verb-lexicon table guards", () => {
  const paradigmsSource = readFileSync(PARADIGMS_PATH, "utf-8");

  it("has a PARADIGMS entry for every class the build script can emit", () => {
    expect(missingParadigmEntries(paradigmsSource)).toEqual([]);
  });

  it("reports the class when a paradigm is missing", () => {
    // ワ行下二段 removed from the paradigm source the guard reads: exactly the
    // slip that shipped a 肥ゆ the app could not conjugate.
    const withoutWaRow = paradigmsSource.replace('"shimo-nidan-wa":', '"shimo-nidan-wa-TYPO":');
    expect(missingParadigmEntries(withoutWaRow)).toEqual(["shimo-nidan-wa"]);
    expect(missingParadigmEntries("")).toContain("yodan-ka");
  });

  it("gives every class a suffix shape no other class claims", () => {
    // `matchBlock` finds a class by scanning for the first shape that fits, so
    // two classes sharing one would make the answer depend on key order.
    expect(duplicateSuffixShapes()).toEqual([]);
  });

  it("keeps the default rows and the widening rows disjoint", () => {
    const overlap = Object.keys(EXTRA_SUFFIX_OF).filter((cls) => cls in SUFFIX_OF);
    expect(overlap).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The rows filled in after ヤ行下二段 — ワ行下二段, ヤ行上二段, ダ行上二段 and
// ハ行下二段. All four are rows the *modern* spelling has collapsed, which is
// why they need attested data and why `modernKana` has to undo the collapse
// before an attested sense can be compared with KANJIDIC2 at all.
// ---------------------------------------------------------------------------

describe("syntheticLexiconEntry — the rows modern spelling has merged", () => {
  it("tells ワ行下二段 from ヤ行下二段, which share a modern え", () => {
    // 植える and 肥える are spelled identically in modern kana and differ in
    // classical: 植ゑ against 肥え. Only the lexicon carries that.
    expect(syntheticLexiconEntry({ reading: "う", okurigana: "える" }, "植")).toMatchObject({
      conjClass: "shimo-nidan-wa",
    });
    expect(syntheticLexiconEntry({ reading: "こ", okurigana: "える" }, "肥")).toMatchObject({
      conjClass: "shimo-nidan-ya",
    });
  });

  it("reaches ヤ行上二段 and ダ行上二段, whose modern い/じ hide the row", () => {
    expect(syntheticLexiconEntry({ reading: "く", okurigana: "いる" }, "悔")).toMatchObject({
      conjClass: "kami-nidan-ya",
    });
    expect(syntheticLexiconEntry({ reading: "は", okurigana: "じる" }, "恥")).toMatchObject({
      conjClass: "kami-nidan-da",
    });
  });

  it("undoes ハ行転呼 before comparing an attested sense with KANJIDIC2", () => {
    // 与へる is KANJIDIC2's 与える and 変はる its 変わる. Without the mapping
    // these compared 'へる' against 'える' and 'はる' against 'わる', matched
    // nothing, and left the modern spelling on the page in an app that writes
    // 習ふ everywhere else.
    expect(syntheticLexiconEntry({ reading: "か", okurigana: "わる" }, "変")).toMatchObject({
      conjClass: "yodan-ra",
      okuriganaPrefix: "は",
    });
    expect(syntheticLexiconEntry({ reading: "ととの", okurigana: "える" }, "整")).toMatchObject({
      conjClass: "shimo-nidan-ha",
    });
  });

  it("gives 種 the class Wiktionary files under 植 instead", () => {
    // Wiktionary has no verb entry for 種 at all, so no amount of row-filling
    // reaches it — the row is what makes the hand-supplied entry expressible.
    expect(VERB_LEXICON["種"]).toEqual({ conjClass: "shimo-nidan-wa", reading: "う" });
    expect(conjugatedOkurigana(VERB_LEXICON["種"], "shuushi")).toBe("う");
    expect(conjugatedOkurigana(VERB_LEXICON["種"], "renyou")).toBe("ゑ");
  });
});

// ---------------------------------------------------------------------------
// 旧字体 spellings at the JMdict lookup. Kanbun is written 獨/亂/學 and JMdict
// is keyed on 独/乱/学, so the pair rule's dictionary gate was refusing real
// compounds for their orthography rather than for what they are.
// ---------------------------------------------------------------------------

describe("shinjitaiSpelling", () => {
  it("modernises every kyūjitai character in a spelling", () => {
    expect(shinjitaiSpelling("獨酌")).toBe("独酌");
    expect(shinjitaiSpelling("大亂")).toBe("大乱");
    expect(shinjitaiSpelling("學")).toBe("学");
  });

  it("returns a spelling with nothing to modernise unchanged", () => {
    expect(shinjitaiSpelling("独酌")).toBe("独酌");
    expect(shinjitaiSpelling("大破")).toBe("大破");
    expect(shinjitaiSpelling("")).toBe("");
  });
});

describe("lookupModernisedLemma", () => {
  it("finds a word JMdict keys under its modern spelling", () => {
    expect(lookupLemma(jmdict, "獨酌")).toBeNull();
    expect(lookupModernisedLemma(jmdict, "獨酌")?.reading).toBe("どくしゃく");
  });

  it("leaves the plain lookup un-normalised", () => {
    // The normalisation is scoped to `onyomiCompound` deliberately — applying
    // it to every JMdict lookup moved 139 transitivity answers and 135
    // per-token resolutions, not all defensibly. This pins the scope so the
    // wider version cannot creep back in unmeasured.
    expect(lookupLemma(jmdict, "學")).toBeNull();
    expect(lookupLemma(jmdict, "亂")).toBeNull();
  });

  it("prefers the spelling as written when JMdict has it", () => {
    expect(lookupModernisedLemma(jmdict, "大破")?.reading).toBe("たいは");
  });
});

describe("the on'yomi pair rule", () => {
  it("reads a kyūjitai-spelled compound on'yomi (獨酌 -> どく・しやく)", () => {
    const tokens = [
      makeToken({ id: 0, text: "獨", lemma: "獨", pos: "ADV", dep: "mod", head: 1 }),
      makeToken({ id: 1, text: "酌", lemma: "酌", pos: "VERB", dep: "ROOT", head: 1 }),
    ];
    expect(resolve(tokens[0], { tokens })).toMatchObject({ reading: "どく" });
    // 歴史的仮名遣い, like every other on'yomi this app prints — しやく, not しゃく.
    expect(resolve(tokens[1], { tokens })).toMatchObject({ reading: "しやく", okurigana: "す" });
  });

  it("refuses an adverb+noun pair no dictionary attests (則利)", () => {
    // 金就礪則利: 則 is すなはち, a clause connective that happens to stand
    // before a noun. The per-character fallback read it そく. An adverb
    // precedes whatever follows it whether or not the two are one word, so
    // adjacency alone cannot license a compound reading here.
    const tokens = [
      makeToken({ id: 0, text: "則", lemma: "則", pos: "ADV", dep: "mod", head: 1 }),
      makeToken({ id: 1, text: "利", lemma: "利", pos: "NOUN", dep: "ROOT", head: 1 }),
    ];
    expect(resolve(tokens[0], { tokens })).toMatchObject({ reading: "すなは", okurigana: "ち" });
  });

  it("keeps the per-character fallback for a numeral counting a noun", () => {
    // 百歩 is not a JMdict headword, and is still read ヒャクホ: a numeral
    // before its noun is counting it and can be doing nothing else, which is
    // the guarantee an adverb does not come with.
    const tokens = [
      makeToken({ id: 0, text: "百", lemma: "百", pos: "NUM", dep: "mod", head: 1 }),
      makeToken({ id: 1, text: "歩", lemma: "歩", pos: "NOUN", dep: "ROOT", head: 1 }),
    ];
    expect(resolve(tokens[0], { tokens })).toMatchObject({ reading: "ひやく" });
    expect(resolve(tokens[1], { tokens })).toMatchObject({ reading: "ほ" });
  });
});

describe("the on'yomi pair rule is re-derived from the parse, never cached", () => {
  // A reading that depends on the tree has to be recomputed when the tree
  // changes, or a correction the user makes by hand appears not to register.
  // Verified live in the app both ways — dragging 獨 off 酌 turns 王獨酌す back
  // into 王獨り酌む, and switching 親 from 動詞 to 名詞 turns あひ親しむ into
  // あひ親なり — and pinned here so no future caching can quietly lose it.

  it("stands down when the modifier is re-attached elsewhere", () => {
    const paired = [
      makeToken({ id: 0, text: "王", lemma: "王", pos: "NOUN", dep: "subj", head: 2 }),
      makeToken({ id: 1, text: "獨", lemma: "獨", pos: "ADV", dep: "mod", head: 2 }),
      makeToken({ id: 2, text: "酌", lemma: "酌", pos: "VERB", dep: "ROOT", head: 2 }),
    ];
    expect(resolve(paired[1], { tokens: paired })).toMatchObject({ reading: "どく" });
    expect(resolve(paired[2], { tokens: paired })).toMatchObject({ reading: "しやく" });

    // The same tokens, with 獨 dragged onto 王 instead. Nothing about the
    // token changed; only its head did.
    const detached = paired.map((t) => (t.id === 1 ? { ...t, head: 0 } : t));
    expect(resolve(detached[1], { tokens: detached })).toMatchObject({ reading: "ひとり" });
    expect(resolve(detached[2], { tokens: detached })).toMatchObject({ reading: "く", okurigana: "む" });
  });

  it("re-decides when the head's part of speech changes", () => {
    const asVerb = [
      makeToken({ id: 0, text: "相", lemma: "相", pos: "ADV", dep: "mod", head: 1 }),
      makeToken({ id: 1, text: "親", lemma: "親", pos: "VERB", dep: "ROOT", head: 1 }),
    ];
    expect(resolve(asVerb[1], { tokens: asVerb })).toMatchObject({ reading: "した", okurigana: "しむ" });

    const asNoun = asVerb.map((t) => (t.id === 1 ? { ...t, pos: "NOUN" } : t));
    expect(resolve(asNoun[1], { tokens: asNoun })).toMatchObject({ reading: "おや" });
  });
});
