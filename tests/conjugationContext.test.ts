import { describe, expect, it } from "vitest";
import type { Sentence, Token } from "../src/parse/types.ts";
import {
  caseParticleFor,
  isExistentialPredicate,
  isNamingUse,
  isNominalizedObjectPredicate,
  isSentenceFinalParticleUse,
  isUnquotedSpeechComplement,
  negationForm,
  quotativeParticleFor,
  conjugatedOkurigana,
  syntheticLexiconEntry,
  decideConjForm,
  extraEndingFor,
  genitiveNoParticle,
  ziReading,
  isTariSuffix,
  tariSuffixGroup,
  conjugationSubject,
  lexiconEntryFor,
} from "../src/kakikudashi/conjugationContext.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type KanjidicIndex } from "../src/reading/kanjidicLookup.ts";
import { type JmdictIndex, lookupLemma, lookupModernisedLemma, shinjitaiSpelling } from "../src/reading/jmdictLookup.ts";
import { createReadingResolver } from "../src/reading/readingResolver.ts";
import { conjugate } from "../src/kakikudashi/classicalConjugation.ts";
import { teOrShite } from "../src/kakikudashi/conjugationContext.ts";
import type { ReadingPlan } from "../src/kundoku/types.ts";
import { computeReadingOrder } from "../src/kundoku/reorderEngine.ts";
import { isSpeechQuoteComplement } from "../src/kundoku/depClassification.ts";
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

  it("reaches the same なり under a non-particle head", () => {
    // This asserted す until the coordination rule was overturned: a nominal
    // coordinated onto a verb was read as a denominal action parallel to it
    // (學禮 -> 學び禮す) rather than as the equative predication it usually
    // is. Both routes now arrive at なり, and the particle head is only a
    // difference in whether the copula needs licensing.
    const s: Sentence = {
      tokens: [
        makeToken({ id: 0, text: "學", lemma: "學", pos: "VERB", dep: "ROOT", head: 0 }),
        makeToken({ id: 1, text: "禮", lemma: "禮", pos: "NOUN", dep: "conj:coord", head: 0 }),
      ],
    };
    expect(extraEndingFor(s.tokens[1], s.tokens[0], s)?.primary).toBe("なり");
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

  it("does not withhold the coordinate clause's copula — that licence is the root's", () => {
    // 生而神靈 with no closing mark. This asserted す, on the reasoning that
    // a noun used *verbally* as one clause of a chain is not a sentence
    // ending in a noun and so needs no licence. The ending is なり now, but
    // the part about the licence still holds and is what this pins: a verbal
    // clause already stands before it, so there is no question of the whole
    // being a noun phrase — only of what the second conjunct does.
    const s: Sentence = {
      tokens: [
        makeToken({ id: 0, text: "生", lemma: "生", pos: "VERB", dep: "ROOT", head: 0 }),
        makeToken({ id: 1, text: "神靈", lemma: "神靈", pos: "NOUN", dep: "conj:coord", head: 0 }),
      ],
    };
    expect(extraEndingFor(s.tokens[1], s.tokens[0], s)?.primary).toBe("なり");
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
// 連体形 where a predicate modifies a following nominal. Every tree below is
// the one the live parser returns for the text named in its comment.
// ---------------------------------------------------------------------------

describe("a predicate modifying through the genitive 之", () => {
  /** 大破之時。 — 破 is 之's `comp:obj` and 之 a `mod` of 時, which is exactly
   * the shape `depClassification.ts`'s `isGenitiveComplement` identifies. */
  const timeOfDefeat: Sentence = {
    tokens: [
      makeToken({ id: 0, text: "大", lemma: "大", pos: "ADV", dep: "mod", head: 1, morph: "Degree=Pos|VerbForm=Conv" }),
      makeToken({ id: 1, text: "破", lemma: "破", pos: "VERB", dep: "comp:obj", head: 2 }),
      makeToken({ id: 2, text: "之", lemma: "之", pos: "SCONJ", dep: "mod", head: 3 }),
      makeToken({ id: 3, text: "時", lemma: "時", pos: "NOUN", dep: "ROOT", head: 3, morph: "Case=Tem" }),
      makeToken({ id: 4, text: "。", lemma: "。", pos: "PUNCT", dep: "punct", head: 3 }),
    ],
  };

  it("gives 破 rentai — 大破するの時", () => {
    expect(decideConjForm(timeOfDefeat.tokens[1], timeOfDefeat.tokens[2], timeOfDefeat, "sa-hen")).toBe("rentai");
  });

  it("outranks the VerbType=Cop renyoukei rule, which the same token would otherwise take", () => {
    const copula: Sentence = {
      tokens: timeOfDefeat.tokens.map((t) => (t.id === 1 ? { ...t, morph: "VerbType=Cop" } : t)),
    };
    expect(decideConjForm(copula.tokens[1], copula.tokens[2], copula, "sa-hen")).toBe("rentai");
  });

  it("leaves the 之 that is an object pronoun alone — 學而時習之", () => {
    // Same lemma, different use: this 之 is a `comp:obj` PRON of 習 rather
    // than a `mod` over a following nominal, and reads これ, not の.
    const pronoun: Sentence = {
      tokens: [
        makeToken({ id: 0, text: "習", lemma: "習", pos: "VERB", dep: "conj:coord", head: 0 }),
        makeToken({ id: 1, text: "之", lemma: "之", pos: "PRON", dep: "comp:obj", head: 0 }),
      ],
    };
    expect(decideConjForm(pronoun.tokens[0], undefined, pronoun, "yodan-ha")).toBe("shuushi");
  });
});

describe("a predicate modifying a following nominalizer", () => {
  /** The reading resolver, reduced to the one answer `decideConjForm` asks
   * it for: how 者 was read. `zheTopicReading` in `readingResolver.ts` is what
   * decides this in the app — もの when a verb modifies 者, は when a bare
   * noun does — and `decideConjForm` consults that answer rather than
   * re-deriving it, so these stubs stand in for the two answers it gives. */
  const readsZheAs = (reading: string) => (() => ({ reading, source: "override" }) as const);

  /** 大破者勝。 — 破 is a `mod` child of 者, and 者 the `subj` of 勝. */
  const oneWhoWins: Sentence = {
    tokens: [
      makeToken({ id: 0, text: "大", lemma: "大", pos: "ADV", dep: "mod", head: 1, morph: "Degree=Pos|VerbForm=Conv" }),
      makeToken({ id: 1, text: "破", lemma: "破", pos: "VERB", dep: "mod", head: 2 }),
      makeToken({ id: 2, text: "者", lemma: "者", pos: "PART", dep: "subj", head: 3 }),
      makeToken({ id: 3, text: "勝", lemma: "勝", pos: "VERB", dep: "ROOT", head: 3 }),
      makeToken({ id: 4, text: "。", lemma: "。", pos: "PUNCT", dep: "punct", head: 3 }),
    ],
  };

  it("gives 破 rentai before a 者 read もの — 大破するもの勝つ", () => {
    expect(decideConjForm(oneWhoWins.tokens[1], oneWhoWins.tokens[2], oneWhoWins, "sa-hen", readsZheAs("もの"))).toBe("rentai");
  });

  it("leaves the predicate of a 者 read は in 終止形 — 黃帝者、少典之子也", () => {
    // The negative case the whole rule turns on: this 者 is the topic marker
    // and nominalizes nothing, so nothing before it is attributive.
    expect(decideConjForm(oneWhoWins.tokens[1], oneWhoWins.tokens[2], oneWhoWins, "sa-hen", readsZheAs("は"))).toBe("shuushi");
  });

  it("leaves 者 alone when no resolver says which reading it took", () => {
    expect(decideConjForm(oneWhoWins.tokens[1], oneWhoWins.tokens[2], oneWhoWins, "sa-hen")).toBe("shuushi");
  });

  it("takes 所 without asking, since 所 has no second reading to distinguish — 君子所大破", () => {
    /** 君子所大破。 — the nominalized predicate is 所's `comp:obj` here, not
     * its `mod`; the relation differs from 者's, the attachment does not. */
    const whatWasDefeated: Sentence = {
      tokens: [
        makeToken({ id: 0, text: "君子", lemma: "君子", pos: "NOUN", dep: "subj", head: 1 }),
        makeToken({ id: 1, text: "所", lemma: "所", pos: "PART", dep: "ROOT", head: 1 }),
        makeToken({ id: 2, text: "大", lemma: "大", pos: "ADV", dep: "mod", head: 3, morph: "Degree=Pos|VerbForm=Conv" }),
        makeToken({ id: 3, text: "破", lemma: "破", pos: "VERB", dep: "comp:obj", head: 1 }),
        makeToken({ id: 4, text: "。", lemma: "。", pos: "PUNCT", dep: "punct", head: 1 }),
      ],
    };
    expect(decideConjForm(whatWasDefeated.tokens[3], whatWasDefeated.tokens[1], whatWasDefeated, "sa-hen")).toBe("rentai");
  });

  it("puts an adjective in 連体形 too — 賢者勝 reads 賢しきもの勝つ", () => {
    const wiseOne: Sentence = {
      tokens: oneWhoWins.tokens.map((t) => (t.id === 1 ? { ...t, text: "賢", lemma: "賢", morph: "Degree=Pos|VerbForm=Part" } : t)),
    };
    expect(decideConjForm(wiseOne.tokens[1], wiseOne.tokens[2], wiseOne, "shiku-keiyoushi", readsZheAs("もの"))).toBe("rentai");
  });

  it("still lets a governing negation take the form — 不知者 is 知らぬもの, not 知るもの", () => {
    /** 不知者。 — 不 is postposed past 知, so it, not 者, is what 知's own
     * ending answers to; the ぬ that reaches 者 is `negationForm`'s. */
    const unknowing: Sentence = {
      tokens: [
        makeToken({ id: 0, text: "不", lemma: "不", pos: "ADV", dep: "mod", head: 1, morph: "Polarity=Neg" }),
        makeToken({ id: 1, text: "知", lemma: "知", pos: "VERB", dep: "mod", head: 2 }),
        makeToken({ id: 2, text: "者", lemma: "者", pos: "PART", dep: "ROOT", head: 2 }),
      ],
    };
    expect(decideConjForm(unknowing.tokens[1], unknowing.tokens[0], unknowing, "yodan-ra", readsZheAs("もの"))).toBe("mizen");
  });

  it("needs the nominalizer to be the very next thing read, not merely the head", () => {
    // 大破之軍者 comes back with 軍 standing between 破 and the 者 it is
    // tagged a `mod` of, and 破's ending lands against 軍 there.
    const distant: Sentence = {
      tokens: [
        ...oneWhoWins.tokens.slice(0, 2),
        makeToken({ id: 5, text: "軍", lemma: "軍", pos: "NOUN", dep: "mod", head: 2 }),
        ...oneWhoWins.tokens.slice(2),
      ],
    };
    expect(decideConjForm(distant.tokens[1], distant.tokens[2], distant, "sa-hen", readsZheAs("もの"))).toBe("shuushi");
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

describe("而 as a connective", () => {
  const plan = (tokens: Token[]): ReadingPlan => ({
    sentence: { tokens },
    order: tokens.map((t) => t.id),
    spliceGroups: [],
    quoteEndIds: new Set<number>(),
    rereadCloseIds: new Map<number, number[]>(),
  });

  it("splits しかも into a reading of 而 and its particle", () => {
    // 而 opening a clause is 而も — しか read *over* the character, も written
    // after it, which is what lets the 訓読文 set it as furigana しか with モ
    // beside rather than as one katakana gloss. See `EruConnective`.
    const tokens = [
      makeToken({ id: 0, text: "青", lemma: "青", pos: "VERB", dep: "ROOT", head: 0, morph: "Degree=Pos" }),
      makeToken({ id: 1, text: "。", lemma: "。", pos: "PUNCT", dep: "punct", head: 0 }),
      makeToken({ id: 2, text: "而", lemma: "而", pos: "CCONJ", dep: "mod", head: 3 }),
      makeToken({ id: 3, text: "寒", lemma: "寒", pos: "VERB", dep: "conj:coord", head: 0, morph: "Degree=Pos" }),
    ];
    expect(teOrShite(plan(tokens), 2)).toEqual({ reading: "しか", okurigana: "も" });
  });

  it("leaves て and して as endings, with nothing read over 而", () => {
    // These are endings on the verb *before* 而, not readings of it, so they
    // carry no reading half at all.
    const plain = [
      makeToken({ id: 0, text: "學", lemma: "學", pos: "VERB", dep: "ROOT", head: 0 }),
      makeToken({ id: 1, text: "而", lemma: "而", pos: "CCONJ", dep: "mod", head: 2 }),
      makeToken({ id: 2, text: "習", lemma: "習", pos: "VERB", dep: "conj:coord", head: 0 }),
    ];
    expect(teOrShite(plan(plain), 1)).toEqual({ okurigana: "て" });

    const negated = [
      makeToken({ id: 0, text: "不", lemma: "不", pos: "ADV", dep: "mod", head: 1, morph: "Polarity=Neg" }),
      makeToken({ id: 1, text: "知", lemma: "知", pos: "VERB", dep: "ROOT", head: 1 }),
      makeToken({ id: 2, text: "而", lemma: "而", pos: "CCONJ", dep: "mod", head: 3 }),
      makeToken({ id: 3, text: "慍", lemma: "慍", pos: "VERB", dep: "conj:coord", head: 1 }),
    ];
    // 不 postposes *after* the verb it negates, so in reading order it is 知,
    // 不, 而 — and it is the token immediately before 而 that decides this.
    expect(teOrShite({ ...plan(negated), order: [1, 0, 2, 3] }, 2)).toEqual({ okurigana: "して" });
  });
});

// ---------------------------------------------------------------------------
// Existential 有/無, and a predicate standing in an object slot. Every tree
// below is copied row-for-row out of a real parse — 酒蟲.conllu for the 謂其身
// 有異疾 / 曰有之 / 苦不得飲 / 固有數 cases, and a live parse of the sentence
// named in the comment for the rest.
// ---------------------------------------------------------------------------

describe("existential 有 takes its locus in に and its existent bare", () => {
  /** 一番僧見之、謂其身有異疾。 — 酒蟲 sent_id 5, tokens 7-11. 身 is a
   * `comp:obj` of 謂, *not* of 有: the parser has given 謂 two objects where
   * the sentence has one small-clause complement, 謂[其身 有異疾]. */
  const strangeDisease: Sentence = {
    tokens: [
      makeToken({ id: 6, text: "謂", lemma: "謂", pos: "VERB", xpos: "v,動詞,行為,伝達", dep: "parataxis", head: 3 }),
      makeToken({ id: 7, text: "其", lemma: "其", pos: "PRON", xpos: "n,代名詞,人称,起格", dep: "det", head: 8 }),
      makeToken({ id: 8, text: "身", lemma: "身", pos: "NOUN", xpos: "n,名詞,不可譲,身体", dep: "comp:obj", head: 6 }),
      makeToken({ id: 9, text: "有", lemma: "有", pos: "VERB", xpos: "v,動詞,存在,存在", dep: "comp:obj", head: 6 }),
      makeToken({ id: 10, text: "異", lemma: "異", pos: "VERB", xpos: "v,動詞,描写,形質", dep: "mod", head: 11, morph: "Degree=Pos|VerbForm=Part" }),
      makeToken({ id: 11, text: "疾", lemma: "疾", pos: "NOUN", xpos: "n,名詞,不可譲,疾病", dep: "comp:obj", head: 9 }),
    ],
  };
  const at = (id: number) => strangeDisease.tokens.find((t) => t.id === id)!;

  it("marks the nominal standing immediately before 有 with に", () => {
    // Was を — 身 is a `comp:obj`, and the blanket comp:obj-takes-を was
    // reading it as a second object of 謂. What licenses the に is position:
    // the existent follows 有 and the locus precedes it.
    expect(caseParticleFor(at(8), strangeDisease)).toBe("に");
  });

  it("gives the existent no particle at all", () => {
    // Nothing is being acted on, so there is no direct object for を to mark:
    // その身に異疾有り, never …異疾を有り.
    expect(caseParticleFor(at(11), strangeDisease)).toBeUndefined();
  });

  it("reports an *unquoted* 有 with を on a 連体形, not と on a 終止形", () => {
    // Reversed deliberately, and this is the case the reversal turns on.
    // 謂其身有異疾 carries no quotation marks at all, and と is now reserved
    // for a complement the source actually quoted (`isQuotedSpeechComplement`
    // — an opening bracket inside the complement's own subtree). An unquoted
    // clausal complement of a speech verb is nominalized instead: 連体形 + を,
    // その身に異疾有るを謂ふ, where this read その身に異疾有りと謂ふ before.
    //
    // `isNominalizedObjectPredicate` still says false — it excludes both a
    // communication verb's complement and an existential 有/無 — so the を and
    // the 連体形 come from `isUnquotedSpeechComplement`, which runs ahead of
    // that exclusion for exactly this token. See its own doc.
    expect(isNominalizedObjectPredicate(at(9), strangeDisease)).toBe(false);
    expect(isUnquotedSpeechComplement(at(9), strangeDisease)).toBe(true);
    expect(quotativeParticleFor(at(9), strangeDisease)).toBeUndefined();
    expect(caseParticleFor(at(9), strangeDisease)).toBe("を");
    expect(decideConjForm(at(9), at(10), strangeDisease, "ra-hen")).toBe("rentai");
  });

  it("keeps と on the same 有 once the complement is bracketed", () => {
    // The one thing that changed is the mark. An opening 「 attached inside
    // the complement's subtree — the closing one is regularly split off into
    // a sentence of its own by this parser and is deliberately not required —
    // makes it a quotation again, and a quotation takes 終止形 + と.
    const quoted: Sentence = {
      tokens: [
        ...strangeDisease.tokens,
        makeToken({ id: 12, text: "「", lemma: "「", pos: "PUNCT", xpos: "s,記号,括弧開,*", dep: "punct", head: 9 }),
      ],
    };
    const q = (id: number) => quoted.tokens.find((t) => t.id === id)!;
    expect(isUnquotedSpeechComplement(q(9), quoted)).toBe(false);
    // The と, but written from `reorderEngine.ts` rather than from here — 謂
    // carries the treebank's 伝達 class, so `isSpeechQuoteComplement` now owns
    // this complement and `quoteEndIds` closes the quote at the last token of
    // its own reading order. Both rules stand down here on purpose: a second
    // と from this file would double the first (有りとと).
    expect(quotativeParticleFor(q(9), quoted)).toBeUndefined();
    expect(caseParticleFor(q(9), quoted)).toBeUndefined();
    expect(isSpeechQuoteComplement(q(9), q(6), quoted)).toBe(true);
    // 終止形 either way: a quotation is not nominalized.
    expect(decideConjForm(q(9), q(10), quoted, "ra-hen")).toBe("shuushi");
  });

  /** 山中有虎。 — live parse. The ordinary shape, where the locus is 有's own
   * `subj`. A code comment in `genitiveNoParticle` records 山は中虎を有り as
   * what this used to give. */
  const tigerInTheHills: Sentence = {
    tokens: [
      makeToken({ id: 1, text: "山", lemma: "山", pos: "NOUN", xpos: "n,名詞,固定物,地形", dep: "mod", head: 2, morph: "Case=Loc" }),
      makeToken({ id: 2, text: "中", lemma: "中", pos: "NOUN", xpos: "n,名詞,固定物,関係", dep: "subj", head: 3, morph: "Case=Loc" }),
      makeToken({ id: 3, text: "有", lemma: "有", pos: "VERB", xpos: "v,動詞,存在,存在", dep: "ROOT", head: 3 }),
      makeToken({ id: 4, text: "虎", lemma: "虎", pos: "NOUN", xpos: "n,名詞,主体,動物", dep: "comp:obj", head: 3 }),
    ],
  };

  it("reaches the same に through 有's own subj", () => {
    expect(caseParticleFor(tigerInTheHills.tokens[1], tigerInTheHills)).toBe("に");
    expect(caseParticleFor(tigerInTheHills.tokens[3], tigerInTheHills)).toBeUndefined();
  });

  /** 有朋自遠方來，不亦樂乎？ — live parse of the standing anchor. 朋 is the
   * `subj` of *來*, and it stands *after* 有, so nothing here is a locus. */
  const friendFromAfar: Sentence = {
    tokens: [
      makeToken({ id: 1, text: "有", lemma: "有", pos: "VERB", xpos: "v,動詞,存在,存在", dep: "ROOT", head: 1 }),
      makeToken({ id: 2, text: "朋", lemma: "朋", pos: "NOUN", xpos: "n,名詞,人,関係", dep: "subj", head: 6 }),
      makeToken({ id: 3, text: "自", lemma: "自", pos: "ADP", xpos: "v,前置詞,経由,*", dep: "mod", head: 6 }),
      makeToken({ id: 4, text: "遠", lemma: "遠", pos: "VERB", xpos: "v,動詞,描写,量", dep: "comp:obj", head: 3, morph: "Degree=Pos" }),
      makeToken({ id: 5, text: "方", lemma: "方", pos: "NOUN", xpos: "n,名詞,固定物,関係", dep: "mod", head: 6, morph: "Case=Loc" }),
      makeToken({ id: 6, text: "來", lemma: "來", pos: "VERB", xpos: "v,動詞,行為,移動", dep: "comp:obj", head: 1 }),
    ],
  };

  it("marks the 有朋自遠方來 anchor's subject の, and its existent bare", () => {
    // 朋 follows 有 rather than preceding it, so the *locus* rule cannot reach
    // it and it takes no に. What it does take is the subordinate subject's
    // の: 來 is the clause 有 asserts, which is a clause in a nominal slot, and
    // a clause in a nominal slot marks its own subject の — 朋**の**遠方より
    // 來る有り, the reading this file's own docs have named as the target all
    // along. See `inAttributiveClause`.
    expect(caseParticleFor(friendFromAfar.tokens[1], friendFromAfar)).toBe("の");
    // 來 is 有's existent and takes no を either, verb though it is.
    expect(caseParticleFor(friendFromAfar.tokens[5], friendFromAfar)).toBeUndefined();
    // 連体形 — 朋の遠方より來る有り. Identical to 終止形 for 四段ラ行, which is
    // why the anchor's rendered text does not move.
    expect(decideConjForm(friendFromAfar.tokens[5], undefined, friendFromAfar, "yodan-ra")).toBe("rentai");
  });

  /** 曰：「有之。」 — 酒蟲 sent_id 10. */
  it("gives 有之 its 之 bare (之有り, not 之を有り)", () => {
    const thereIs: Sentence = {
      tokens: [
        makeToken({ id: 1, text: "曰", lemma: "曰", pos: "VERB", xpos: "v,動詞,行為,伝達", dep: "ROOT", head: 1 }),
        makeToken({ id: 4, text: "有", lemma: "有", pos: "VERB", xpos: "v,動詞,存在,存在", dep: "comp:obj", head: 1 }),
        makeToken({ id: 5, text: "之", lemma: "之", pos: "PRON", xpos: "n,代名詞,人称,止格", dep: "comp:obj", head: 4, morph: "Person=3|PronType=Prs" }),
      ],
    };
    expect(caseParticleFor(thereIs.tokens[2], thereIs)).toBeUndefined();
  });

  /** 豈飲啄固有數乎？ — 酒蟲 sent_id 35, tokens 28-32. */
  it("gives 固有數 its 數 bare, and its verbal subj the こと a nominalized clause takes", () => {
    const fixedNumber: Sentence = {
      tokens: [
        makeToken({ id: 28, text: "飲", lemma: "飲", pos: "VERB", xpos: "v,動詞,行為,飲食", dep: "subj", head: 31 }),
        makeToken({ id: 29, text: "啄", lemma: "啄", pos: "VERB", xpos: "v,動詞,行為,飲食", dep: "flat@vv", head: 28 }),
        makeToken({ id: 30, text: "固", lemma: "固", pos: "ADV", xpos: "v,副詞,判断,確定", dep: "mod", head: 31 }),
        makeToken({ id: 31, text: "有", lemma: "有", pos: "VERB", xpos: "v,動詞,存在,存在", dep: "parataxis", head: 4 }),
        makeToken({ id: 32, text: "數", lemma: "數", pos: "NOUN", xpos: "n,名詞,数量,*", dep: "comp:obj", head: 31 }),
      ],
    };
    expect(caseParticleFor(fixedNumber.tokens[4], fixedNumber)).toBeUndefined();
    // 飲 is 有's subj and a predicate, not a place — so no に, which would be a
    // guess about what kind of argument it is. What it does take is こと: a
    // clause standing in a subject slot is nominalized. The 啄 fused onto it by
    // `flat@vv` used to block that (飲啄 is one word, and counting 啄 as a
    // following word made 飲 not the last thing read in its own subtree), so
    // the こと was written nowhere at all. Both panels ask about the span's
    // carrier and emit the answer after its last member, so this prints
    // 飲啄こと.
    expect(caseParticleFor(fixedNumber.tokens[0], fixedNumber)).toBe("こと");
    // 啄 itself carries nothing — it is the same word, not a second one.
    expect(caseParticleFor(fixedNumber.tokens[1], fixedNumber)).toBeUndefined();
  });

  /** 無損其富 — 酒蟲 sent_id 35, token 12. 無 as a preverbal converb takes no
   * complement of its own, and the VERB requirement is what tells it apart
   * from the existential use. */
  it("does not treat a preverbal converb 無 as an existential predicate", () => {
    const withoutHarm = makeToken({
      id: 12, text: "無", lemma: "無", pos: "ADV", xpos: "v,動詞,存在,存在", dep: "mod", head: 13,
      morph: "Polarity=Neg|VerbForm=Conv",
    });
    expect(isExistentialPredicate(withoutHarm)).toBe(false);
  });
});

describe("a verb that is the object of a verb", () => {
  /** 而苦不得飲。 — 酒蟲 sent_id 23, tokens 11-15. */
  const cannotDrink: Sentence = {
    tokens: [
      makeToken({ id: 12, text: "苦", lemma: "苦", pos: "VERB", xpos: "v,動詞,描写,態度", dep: "subj", head: 14, morph: "Degree=Pos" }),
      makeToken({ id: 13, text: "不", lemma: "不", pos: "ADV", xpos: "v,副詞,否定,無界", dep: "mod", head: 14, morph: "Polarity=Neg" }),
      makeToken({ id: 14, text: "得", lemma: "得", pos: "VERB", xpos: "v,動詞,行為,得失", dep: "conj:coord", head: 3 }),
      makeToken({ id: 15, text: "飲", lemma: "飲", pos: "VERB", xpos: "v,動詞,行為,飲食", dep: "comp:obj", head: 14 }),
    ],
  };
  const drink = cannotDrink.tokens[3];
  const obtain = cannotDrink.tokens[2];
  const not = cannotDrink.tokens[1];

  it("takes を: 飲むを得ず, not 飲む得ず", () => {
    expect(caseParticleFor(drink, cannotDrink)).toBe("を");
  });

  it("takes 連体形, the same form 者 and genitive 之 already pull", () => {
    // In reading order 飲 comes first and 得 follows it (comp:obj inverts), so
    // 得 is what its form answers to. 連体形 and 終止形 coincide for 四段マ行,
    // which is why 飲む does not itself move — the を is the visible half.
    expect(decideConjForm(drink, obtain, cannotDrink, "yodan-ma")).toBe("rentai");
  });

  it("leaves the negation and the potential verb exactly as they were", () => {
    // 不 postposes past 得, so 得's own next token is the negation and 未然形
    // still wins over everything: 得 え + ず.
    expect(decideConjForm(obtain, not, cannotDrink, "shimo-nidan-a")).toBe("mizen");
    expect(caseParticleFor(obtain, cannotDrink)).toBeUndefined();
  });

  /** 至不能給。 — 酒蟲 sent_id 34, tokens 13-16. */
  it("does not reach 能/得's own comp:aux, nor an AUX complement", () => {
    const cannotProvide: Sentence = {
      tokens: [
        makeToken({ id: 13, text: "至", lemma: "至", pos: "VERB", xpos: "v,動詞,行為,移動", dep: "parataxis", head: 8 }),
        makeToken({ id: 14, text: "不", lemma: "不", pos: "ADV", xpos: "v,副詞,否定,無界", dep: "mod", head: 15, morph: "Polarity=Neg" }),
        makeToken({ id: 15, text: "能", lemma: "能", pos: "AUX", xpos: "v,助動詞,可能,*", dep: "comp:obj", head: 13, morph: "Mood=Pot" }),
        makeToken({ id: 16, text: "給", lemma: "給", pos: "VERB", xpos: "v,動詞,行為,交流", dep: "comp:aux", head: 15 }),
      ],
    };
    // 能 is the potential auxiliary — rendered as postposed kana with the
    // negation written after it, so a particle of its own would land inside
    // that chain (給ふべから+を+ず). 給 is its `comp:aux`, not an object.
    expect(isNominalizedObjectPredicate(cannotProvide.tokens[2], cannotProvide)).toBe(false);
    expect(isNominalizedObjectPredicate(cannotProvide.tokens[3], cannotProvide)).toBe(false);
    expect(caseParticleFor(cannotProvide.tokens[2], cannotProvide)).toBeUndefined();
    expect(caseParticleFor(cannotProvide.tokens[3], cannotProvide)).toBeUndefined();
  });

  /** 或言：『…以成其術。』 — 酒蟲 sent_id 36, tokens 2/20. 言 carries the
   * treebank's 伝達 class, as 曰/云/問/謂 do. */
  it("leaves a communication verb's complement alone", () => {
    const saidThat: Sentence = {
      tokens: [
        makeToken({ id: 2, text: "言", lemma: "言", pos: "VERB", xpos: "v,動詞,行為,伝達", dep: "ROOT", head: 2 }),
        makeToken({ id: 20, text: "成", lemma: "成", pos: "VERB", xpos: "v,動詞,行為,生産", dep: "comp:obj", head: 2 }),
      ],
    };
    // A reported proposition, not a nominalized action: …術を成すと言ふ, never
    // …成すを言ふ.
    expect(isNominalizedObjectPredicate(saidThat.tokens[1], saidThat)).toBe(false);
  });

  /** 食肉飲酒歌舞。 — live parse of the standing anchor. 歌 comes back UPOS
   * VERB with a *noun* xpos, and 舞 hangs off it as `comp:obj`. */
  it("leaves the 食肉飲酒歌舞 anchor alone", () => {
    const feasting: Sentence = {
      tokens: [
        makeToken({ id: 3, text: "飲", lemma: "飲", pos: "VERB", xpos: "v,動詞,行為,飲食", dep: "parataxis", head: 1 }),
        makeToken({ id: 5, text: "歌", lemma: "歌", pos: "VERB", xpos: "n,名詞,可搬,伝達", dep: "parataxis", head: 3 }),
        makeToken({ id: 6, text: "舞", lemma: "舞", pos: "VERB", xpos: "v,動詞,行為,動作", dep: "comp:obj", head: 5 }),
      ],
    };
    // 歌 is the noun "song" as far as the xpos goes, so it is no predicate
    // taking a complement — the anchor read 舞ふを歌ふ where it had read
    // 舞ふ歌ふ until the governor was held to the same test as the token.
    expect(isNominalizedObjectPredicate(feasting.tokens[2], feasting)).toBe(false);
    expect(caseParticleFor(feasting.tokens[2], feasting)).toBeUndefined();
  });

  /** 置良醞一器。 — 酒蟲 sent_id 21, tokens 3-5. */
  it("leaves a noun the parser tagged VERB alone", () => {
    const goodWine: Sentence = {
      tokens: [
        makeToken({ id: 3, text: "置", lemma: "置", pos: "VERB", xpos: "v,動詞,行為,設置", dep: "ROOT", head: 3 }),
        makeToken({ id: 4, text: "良", lemma: "良", pos: "VERB", xpos: "v,動詞,描写,形質", dep: "mod", head: 5, morph: "Degree=Pos|VerbForm=Part" }),
        makeToken({ id: 5, text: "醞", lemma: "醞", pos: "VERB", xpos: "n,名詞,可搬,道具", dep: "comp:obj", head: 3 }),
      ],
    };
    // 醞 ("brew") is a noun, and its xpos says so even though the UPOS column
    // does not — the rule is about a *predicate* standing in an object slot.
    expect(isNominalizedObjectPredicate(goodWine.tokens[2], goodWine)).toBe(false);
  });
});

describe("what a verb of speech reports takes と, not を", () => {
  /** 劉答言：「無。」 — 酒蟲 sent_id 6. 言 is not one of the two lemmas
   * `depClassification.ts` used to keep (曰, 云), so nothing was closing this
   * quote: it read 無し言ふ. */
  const answeredNo: Sentence = {
    tokens: [
      makeToken({ id: 1, text: "劉", lemma: "劉", pos: "PROPN", xpos: "n,名詞,人,姓氏", dep: "subj", head: 3, morph: "NameType=Sur" }),
      makeToken({ id: 2, text: "答", lemma: "答", pos: "PROPN", xpos: "v,動詞,行為,伝達", dep: "flat", head: 1, morph: "NameType=Giv" }),
      makeToken({ id: 3, text: "言", lemma: "言", pos: "VERB", xpos: "v,動詞,行為,伝達", dep: "ROOT", head: 3 }),
      makeToken({ id: 5, text: "「", lemma: "「", pos: "PUNCT", xpos: "s,記号,括弧開,*", dep: "punct", head: 6 }),
      makeToken({ id: 6, text: "無", lemma: "無", pos: "VERB", xpos: "v,動詞,存在,存在", dep: "comp:obj", head: 3, morph: "Polarity=Neg" }),
      makeToken({ id: 7, text: "。", lemma: "。", pos: "PUNCT", xpos: "s,記号,句点,*", dep: "punct", head: 6 }),
    ],
  };

  it("closes a quote its governor's lemma is not on any list for", () => {
    // The treebank's own 伝達 class is what identifies the speech verb, so 言
    // (and 謂, and 問) behave as 曰 does without a list to maintain — including
    // in `depClassification.ts`, which now reads the same field. That is what
    // moved the と: the quote is closed at the end of its own reading order by
    // `reorderEngine.ts`'s `quoteEndIds` (劉答へ言ふ、「無し」と), and both
    // rules here stand down so the two do not double up.
    expect(quotativeParticleFor(answeredNo.tokens[4], answeredNo)).toBeUndefined();
    expect(caseParticleFor(answeredNo.tokens[4], answeredNo)).toBeUndefined();
    expect(isSpeechQuoteComplement(answeredNo.tokens[4], answeredNo.tokens[2], answeredNo)).toBe(true);
    expect(computeReadingOrder(answeredNo).quoteEndIds.has(6)).toBe(true);
  });

  it("is not fooled by a noun whose class name ends 伝達", () => {
    // 術 in 成其術 is `n,名詞,可搬,伝達` — a noun *about* transmission. A
    // substring test made it a speech verb.
    const skill: Sentence = {
      tokens: [
        makeToken({ id: 20, text: "成", lemma: "成", pos: "VERB", xpos: "v,動詞,行為,生産", dep: "comp:obj", head: 2 }),
        makeToken({ id: 22, text: "術", lemma: "術", pos: "NOUN", xpos: "n,名詞,可搬,伝達", dep: "comp:obj", head: 20 }),
      ],
    };
    expect(quotativeParticleFor(skill.tokens[1], skill)).toBeUndefined();
    // …and the ordinary object particle still applies to it.
    expect(caseParticleFor(skill.tokens[1], skill)).toBe("を");
  });

  /** 曰：「易耳。」 — 酒蟲 sent_id 15. */
  it("stands down where reorderEngine already closes the quote", () => {
    const easyEnough: Sentence = {
      tokens: [
        makeToken({ id: 1, text: "曰", lemma: "曰", pos: "VERB", xpos: "v,動詞,行為,伝達", dep: "ROOT", head: 1 }),
        makeToken({ id: 4, text: "易", lemma: "易", pos: "VERB", xpos: "v,動詞,描写,形質", dep: "comp:obj", head: 1, morph: "Degree=Pos" }),
        makeToken({ id: 5, text: "耳", lemma: "耳", pos: "PART", xpos: "p,助詞,句末,*", dep: "discourse@sp", head: 4 }),
      ],
    };
    // 曰 is on `isSpeechQuoteComplement`'s own lemma set, so `quoteEndIds`
    // writes the と at the true end of the quote — after the 耳 that follows 易.
    // A second one here gave 易しとと.
    expect(quotativeParticleFor(easyEnough.tokens[1], easyEnough)).toBeUndefined();
  });

  /** 曰：「易耳。」 again, for the form the 耳 pulls out of the predicate it
   * closes. のみ is a 副助詞 and attaches to a 連体形 — 易きのみ, not 易しのみ. */
  it("puts the predicate a 限定 耳 closes into 連体形", () => {
    const easyEnough: Sentence = {
      tokens: [
        makeToken({ id: 1, text: "曰", lemma: "曰", pos: "VERB", xpos: "v,動詞,行為,伝達", dep: "ROOT", head: 1 }),
        makeToken({ id: 4, text: "易", lemma: "易", pos: "VERB", xpos: "v,動詞,描写,形質", dep: "comp:obj", head: 1, morph: "Degree=Pos" }),
        makeToken({ id: 5, text: "耳", lemma: "耳", pos: "PART", xpos: "p,助詞,句末,*", dep: "discourse@sp", head: 4 }),
      ],
    };
    expect(decideConjForm(easyEnough.tokens[1], easyEnough.tokens[2], easyEnough, "shiku-keiyoushi")).toBe("rentai");
    // An adjective's own 連体形, not a verb paradigm's — き for ク活用,
    // しき for シク活用, which is what the resolver's やさし makes 易 here.
    expect(conjugate("ku-keiyoushi", "rentai")).toBe("き");
    expect(conjugate("shiku-keiyoushi", "rentai")).toBe("しき");
  });

  it("gives a *negated* predicate the ざり-paradigm 連体形 before 耳", () => {
    // 不知之耳 -> これを知らざるのみ. The ず stands between the predicate and
    // the のみ, so it is ず that has to be attributive, and ざる is the 連体形
    // it uses to carry something further (ぬ stays the one that modifies a
    // following noun).
    const er = makeToken({ id: 5, text: "耳", lemma: "耳", pos: "PART", xpos: "p,助詞,句末,*", dep: "discourse@sp", head: 4 });
    expect(negationForm(er)).toBe("ざる");
    expect(negationForm(makeToken({ id: 5, text: "人", lemma: "人", pos: "NOUN", xpos: "n,名詞,人,人", dep: "comp:obj", head: 4 }))).toBe("ぬ");
  });

  it("leaves the noun 耳 (みみ) alone, though it stands last — 割其耳", () => {
    // The reverse of the 否 rescue: `isSentenceFinalParticleUse`'s positional
    // fallback must not claim a nominal merely because nothing follows it.
    // This is also what keeps のみ off the noun now that 耳 is in
    // `SENTENCE_FINAL_WORD_LEMMAS` and reads over the character: that set is
    // keyed on the lemma, and this predicate is the gate in front of it.
    const ear: Sentence = {
      tokens: [
        makeToken({ id: 1, text: "割", lemma: "割", pos: "VERB", xpos: "v,動詞,行為,動作", dep: "ROOT", head: 1 }),
        makeToken({ id: 2, text: "其", lemma: "其", pos: "PRON", xpos: "p,代名詞,868,*", dep: "det", head: 3 }),
        makeToken({ id: 3, text: "耳", lemma: "耳", pos: "NOUN", xpos: "n,名詞,不可譲,身体", dep: "comp:obj", head: 1 }),
      ],
    };
    expect(isSentenceFinalParticleUse(ear.tokens[2], ear)).toBe(false);
    expect(caseParticleFor(ear.tokens[2], ear)).toBe("を");
  });

  /** 問：「將何用？」 — 酒蟲 sent_id 28. */
  it("stands down where something is still read after the complement", () => {
    const whatFor: Sentence = {
      tokens: [
        makeToken({ id: 1, text: "問", lemma: "問", pos: "VERB", xpos: "v,動詞,行為,伝達", dep: "ROOT", head: 1 }),
        makeToken({ id: 4, text: "將", lemma: "將", pos: "ADV", xpos: "v,副詞,時相,将来", dep: "mod", head: 6, morph: "AdvType=Tim|Tense=Fut" }),
        makeToken({ id: 5, text: "何", lemma: "何", pos: "ADV", xpos: "v,副詞,疑問,原因", dep: "mod", head: 6, morph: "AdvType=Cau" }),
        makeToken({ id: 6, text: "用", lemma: "用", pos: "VERB", xpos: "v,動詞,行為,動作", dep: "comp:obj", head: 1 }),
      ],
    };
    // 將 is a 再読文字: read まさに where it stands and んとす again after the
    // clause 用 closes. A particle on 用 lands between the two (用ゐとんとす),
    // and its second reading is no token of its own for the movement rules to
    // place — hence the direct `isRereadUse` check.
    expect(quotativeParticleFor(whatFor.tokens[3], whatFor)).toBeUndefined();
  });

  /** 或言：『…以成其術。』 — 酒蟲 sent_id 36, the shape where the complement
   * really is the last thing read: every child of 成 either inverts before it
   * (術) or stands before it in the source (入, 以). */
  it("reaches a complement with children, when they are all read before it", () => {
    const saidThat: Sentence = {
      tokens: [
        makeToken({ id: 2, text: "言", lemma: "言", pos: "VERB", xpos: "v,動詞,行為,伝達", dep: "ROOT", head: 2 }),
        // The opening 『, carried in the fixture because it is what makes this
        // a quotation at all — the parse attaches it inside 成's subtree, and
        // the と now depends on it (see `isQuotedSpeechComplement`).
        makeToken({ id: 4, text: "『", lemma: "『", pos: "PUNCT", xpos: "s,記号,括弧開,*", dep: "punct", head: 20 }),
        makeToken({ id: 19, text: "以", lemma: "以", pos: "ADV", xpos: "v,動詞,行為,動作", dep: "mod", head: 20, morph: "VerbForm=Conv" }),
        makeToken({ id: 20, text: "成", lemma: "成", pos: "VERB", xpos: "v,動詞,行為,生産", dep: "comp:obj", head: 2 }),
        makeToken({ id: 22, text: "術", lemma: "術", pos: "NOUN", xpos: "n,名詞,可搬,伝達", dep: "comp:obj", head: 20 }),
        makeToken({ id: 23, text: "。", lemma: "。", pos: "PUNCT", xpos: "s,記号,句点,*", dep: "punct", head: 20 }),
      ],
    };
    const cheng = saidThat.tokens.find((t) => t.id === 20)!;
    // The と, written from `reorderEngine.ts` — 言 carries the 伝達 class, so
    // `isSpeechQuoteComplement` owns this complement and closes the quote at
    // the last token of its own reading order, which is 成 itself (術 inverts
    // before it). This file stands down rather than writing a second one.
    expect(quotativeParticleFor(cheng, saidThat)).toBeUndefined();
    expect(caseParticleFor(cheng, saidThat)).toBeUndefined();
    expect(computeReadingOrder(saidThat).quoteEndIds.has(20)).toBe(true);
    // 終止形, not the 連体形 a nominalized object would take.
    expect(isNominalizedObjectPredicate(cheng, saidThat)).toBe(false);
    expect(decideConjForm(cheng, undefined, saidThat, "yodan-sa")).toBe("shuushi");
  });

  /** 僧曰：「君飲嘗不醉否？」 — 酒蟲 sent_id 8, where 否 is the sentence-final
   * particle read や and the parser has read it as the verb 否む. */
  describe("否 as a sentence-final particle", () => {
    const orNot: Sentence = {
      tokens: [
        makeToken({ id: 2, text: "曰", lemma: "曰", pos: "VERB", xpos: "v,動詞,行為,伝達", dep: "ROOT", head: 2 }),
        makeToken({ id: 9, text: "醉", lemma: "醉", pos: "VERB", xpos: "v,動詞,描写,態度", dep: "comp:obj", head: 2, morph: "Degree=Pos" }),
        makeToken({ id: 10, text: "否", lemma: "否", pos: "VERB", xpos: "v,動詞,描写,態度", dep: "comp:obj", head: 9, morph: "Degree=Pos" }),
        makeToken({ id: 11, text: "？", lemma: "？", pos: "PUNCT", xpos: "s,記号,句点,*", dep: "punct", head: 9 }),
      ],
    };

    it("recognizes the particle use by position and drops the spurious を", () => {
      // 否 stands last among the sentence's non-punctuation tokens, which is
      // where a sentence-final particle stands. Without this it was a VERB in
      // an object slot — `isNominalizedObjectPredicate`'s shape — and picked
      // up を: 君飲む嘗て否むを醉はずと.
      expect(isSentenceFinalParticleUse(orNot.tokens[2], orNot)).toBe(true);
      expect(caseParticleFor(orNot.tokens[2], orNot)).toBeUndefined();
    });

    it("leaves the verb 否む alone where something follows it — 然歟否歟？", () => {
      // 酒蟲 sent_id 38. This 否 is the sentence's own ROOT with a 歟 after it,
      // so it is the verb, not the tag. Position is the only discriminator
      // available, and it has to cut both ways or 否む disappears everywhere.
      const soOrNot: Sentence = {
        tokens: [
          makeToken({ id: 1, text: "然", lemma: "然", pos: "ADV", xpos: "v,動詞,描写,態度", dep: "subj", head: 3, morph: "Degree=Pos|VerbForm=Conv" }),
          makeToken({ id: 2, text: "歟", lemma: "歟", pos: "PART", xpos: "p,助詞,句末,*", dep: "discourse@sp", head: 1 }),
          makeToken({ id: 3, text: "否", lemma: "否", pos: "VERB", xpos: "v,動詞,描写,態度", dep: "ROOT", head: 3, morph: "Degree=Pos" }),
          makeToken({ id: 4, text: "歟", lemma: "歟", pos: "PART", xpos: "p,助詞,句末,*", dep: "discourse@sp", head: 3 }),
          makeToken({ id: 5, text: "？", lemma: "？", pos: "PUNCT", xpos: "s,記号,句点,*", dep: "punct", head: 3 }),
        ],
      };
      expect(isSentenceFinalParticleUse(soOrNot.tokens[2], soOrNot)).toBe(false);
    });

    it("takes a properly tagged discourse particle whatever its position", () => {
      // The ordinary case needs no position evidence: 乎/也/矣/哉/夫/焉 all
      // arrive as `discourse@sp`, and so does a 否 in a corrected tree.
      const tagged: Sentence = {
        tokens: [
          makeToken({ id: 9, text: "醉", lemma: "醉", pos: "VERB", xpos: "v,動詞,描写,態度", dep: "ROOT", head: 9, morph: "Degree=Pos" }),
          makeToken({ id: 10, text: "否", lemma: "否", pos: "PART", xpos: "p,助詞,句末,*", dep: "discourse@sp", head: 9 }),
        ],
      };
      expect(isSentenceFinalParticleUse(tagged.tokens[1], tagged)).toBe(true);
    });
  });

  /** 曰：「此酒蟲也。」 — 酒蟲 sent_id 12. */
  it("takes the naming rule's を off a nominal closed by a sentence-final particle", () => {
    const theWineWorm: Sentence = {
      tokens: [
        makeToken({ id: 1, text: "曰", lemma: "曰", pos: "VERB", xpos: "v,動詞,行為,伝達", dep: "ROOT", head: 1 }),
        makeToken({ id: 4, text: "此", lemma: "此", pos: "PRON", xpos: "n,代名詞,指示,*", dep: "subj", head: 6, morph: "PronType=Dem" }),
        makeToken({ id: 5, text: "酒", lemma: "酒", pos: "NOUN", xpos: "n,名詞,可搬,糧食", dep: "mod", head: 6 }),
        makeToken({ id: 6, text: "蟲", lemma: "蟲", pos: "NOUN", xpos: "n,名詞,主体,動物", dep: "comp:obj", head: 1 }),
        makeToken({ id: 7, text: "也", lemma: "也", pos: "PART", xpos: "p,助詞,句末,*", dep: "discourse@sp", head: 6 }),
      ],
    };
    // A NOUN carrier is ordinarily a naming complement (名曰軒轅) and takes
    // `namingComplementParticle`'s を. 也 overrules that: nothing in Literary
    // Chinese puts a sentence-final particle after a bare name, so 蟲 is not
    // being named but asserted — 此れ酒の蟲なり — and heads a clause. Both the
    // naming rule and the blanket comp:obj-takes-を below it stand down, which
    // is what takes 此酒の蟲をなり back to 此酒の蟲なり.
    //
    // The と the clause should then end in is *not* written here, and cannot
    // be: it belongs after the 也/なり that is read past this token, and the
    // machinery that places a quote-closing と is `reorderEngine.ts`'s, keyed
    // on `depClassification.ts`'s `isSpeechQuoteComplement`, which excludes a
    // NOUN complement. See `isNamingUse`'s doc.
    expect(quotativeParticleFor(theWineWorm.tokens[3], theWineWorm)).toBeUndefined();
    expect(caseParticleFor(theWineWorm.tokens[3], theWineWorm)).toBeUndefined();
    // The governor's side of the same decision. 曰 keeps its `fixedReading`
    // 曰はく — a nominal closed by 也 heads a clause, so this is not a naming
    // and 曰ふ is not what it wants.
    expect(isNamingUse(theWineWorm.tokens[0], theWineWorm)).toBe(false);
  });

  /** 名曰軒轅 — the pattern the naming rule exists for. */
  it("keeps 曰ふ where the complement really is a name", () => {
    const named: Sentence = {
      tokens: [
        makeToken({ id: 0, text: "名", lemma: "名", pos: "NOUN", xpos: "n,名詞,describe,*", dep: "subj", head: 1 }),
        makeToken({ id: 1, text: "曰", lemma: "曰", pos: "VERB", xpos: "v,動詞,行為,伝達", dep: "ROOT", head: 1 }),
        makeToken({ id: 2, text: "軒轅", lemma: "軒轅", pos: "PROPN", xpos: "n,名詞,人,名", dep: "comp:obj", head: 1, morph: "NameType=Prs" }),
      ],
    };
    // No sentence-final particle anywhere, which is exactly the discriminator:
    // 軒轅 is being named, so 曰 conjugates (名を軒轅と曰ふ) rather than taking
    // the quote-frame reading.
    expect(isNamingUse(named.tokens[1], named)).toBe(true);
  });

  /** 子曰：「習之。」 with the opening bracket, and the same tree without it. */
  const master = (bracketed: boolean): Sentence => ({
    tokens: [
      makeToken({ id: 0, text: "子", lemma: "子", pos: "NOUN", xpos: "n,名詞,人,役割", dep: "subj", head: 1 }),
      makeToken({ id: 1, text: "曰", lemma: "曰", pos: "VERB", xpos: "v,動詞,行為,伝達", dep: "ROOT", head: 1 }),
      ...(bracketed ? [makeToken({ id: 2, text: "「", lemma: "「", pos: "PUNCT", xpos: "s,記号,括弧開,*", dep: "punct", head: 3 })] : []),
      makeToken({ id: 3, text: "習", lemma: "習", pos: "VERB", xpos: "v,動詞,行為,動作", dep: "comp:obj", head: 1 }),
      makeToken({ id: 4, text: "之", lemma: "之", pos: "PRON", xpos: "n,代名詞,人称,third", dep: "comp:obj", head: 3 }),
    ],
  });

  it("keeps 曰はく for a bracketed clause — 子曰：「習之。」", () => {
    expect(isNamingUse(master(true).tokens[1], master(true))).toBe(false);
  });

  it("takes 曰ふ for the same clause unbracketed", () => {
    // An unbracketed clausal complement is an ordinary object, not a
    // quotation: it takes 連体形 + を (`isUnquotedSpeechComplement`), and with
    // no と closing it, 曰はく would strand the frame after the clause it
    // introduces. 曰有之 reads これ有るを曰ふ, the same as 言有之 always has.
    expect(isNamingUse(master(false).tokens[1], master(false))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// タリ活用形容動詞: the three predicates the rule is built out of.
//
// Every row carries the real XPOS, since `p,接尾辞,*,*` *is* the rule. Counts
// quoted below are from lzh-train/dev/test in `assets_sud`.
// ---------------------------------------------------------------------------

describe("isTariSuffix / tariSuffixGroup / conjugationSubject", () => {
  const SUFFIX_XPOS = "p,接尾辞,*,*";
  const tok = (id: number, text: string, pos: string, xpos: string, dep: string, head: number): Token =>
    ({ id, text, lemma: text, pos, xpos, dep, head });

  it("admits the suffix use and refuses the verbal one — the same character", () => {
    // 430 suffix-tagged 然 against 1,470 tagged `v,動詞,描写,態度`, with no
    // overlap in either direction. This is the whole discriminator.
    expect(isTariSuffix(tok(1, "然", "PART", SUFFIX_XPOS, "unk", 0))).toBe(true);
    expect(isTariSuffix(tok(1, "然", "VERB", "v,動詞,描写,態度", "ROOT", 1))).toBe(false);
    expect(isTariSuffix(tok(1, "然", "ADV", "v,動詞,描写,態度", "mod", 2))).toBe(false);
  });

  it("refuses the clause-initial 然 — the four `mod` rows", () => {
    // 兮，然欿傺… — the suffix tag but not a suffix, and `dep` is what says so.
    expect(isTariSuffix(tok(2, "然", "PART", SUFFIX_XPOS, "mod", 3))).toBe(false);
  });

  it("admits only the five characters the survey settled on", () => {
    for (const ch of ["然", "如", "爾", "乎", "焉"]) {
      expect(isTariSuffix(tok(1, ch, "PART", SUFFIX_XPOS, "unk", 0))).toBe(true);
    }
    // 兮 never stands adjacent to its head at all; 斯/子/甫 are too few to
    // generalise from and are nouns and 詩經 line-particles besides; 尔 has no
    // KANJIDIC entry to take an on'yomi from.
    for (const ch of ["兮", "斯", "子", "甫", "尔"]) {
      expect(isTariSuffix(tok(1, ch, "PART", SUFFIX_XPOS, "unk", 0))).toBe(false);
    }
  });

  it("refuses 乎 after an exclamatory or interrogative stem — 嗟乎 and 惡乎", () => {
    // The two shapes that kept 乎 out until the corpus separated them from the
    // descriptive binoms. 嗟乎 (20 tokens) is ああ, an INTJ その `TARI_STEM_POS`
    // never admitted; 惡乎/恶乎 (14) is いづくにか, and the interrogative
    // subcategory of the stem's own XPOS is what says so.
    const aa: Sentence = {
      tokens: [tok(0, "嗟", "INTJ", "p,感嘆詞,*,*", "unk", 1), tok(1, "乎", "PART", SUFFIX_XPOS, "unk", 0)],
    };
    expect(tariSuffixGroup(aa.tokens[1], aa)).toBeNull();
    const izuku: Sentence = {
      tokens: [tok(0, "惡", "ADV", "v,副詞,疑問,所在", "mod", 2), tok(1, "乎", "PART", SUFFIX_XPOS, "unk", 0), tok(2, "在", "VERB", "v,動詞,存在,存在", "ROOT", 2)],
    };
    expect(tariSuffixGroup(izuku.tokens[1], izuku)).toBeNull();
    // …while the descriptive stems the same character takes are admitted: 巍乎,
    // 洋乎, 忽乎 — 56 tokens once the two exclusions above are taken out.
    const gi: Sentence = {
      tokens: [tok(0, "巍", "VERB", "v,動詞,描写,形質", "ROOT", 0), tok(1, "乎", "PART", SUFFIX_XPOS, "unk", 0)],
    };
    expect(tariSuffixGroup(gi.tokens[1], gi)?.stem.text).toBe("巍");
    // 焉 needed neither guard: all 36 are `unk` with a descriptive stem.
    const kotsu: Sentence = {
      tokens: [tok(0, "忽", "ADV", "v,副詞,時相,緊接", "mod", 2), tok(1, "焉", "PART", SUFFIX_XPOS, "unk", 0), tok(2, "去", "VERB", "v,動詞,行為,移動", "ROOT", 2)],
    };
    expect(kotsu.tokens[1] && tariSuffixGroup(kotsu.tokens[1], kotsu)?.stem.text).toBe("忽");
  });

  it("lets the suffix tag beat the sentence-final position, but never the discourse tag", () => {
    // The collision that kept 乎/焉 out: both are in `SENTENCE_FINAL_PARTICLES`
    // and 34 of 乎's 102 suffix-tagged tokens stand last. A suffix with a stem
    // is not the particle, last or not — so the tag decides and the position
    // does not.
    const last: Sentence = {
      tokens: [
        tok(0, "洋", "NOUN", "n,名詞,固定物,地形", "ROOT", 0),
        tok(1, "乎", "PART", SUFFIX_XPOS, "unk", 0),
        tok(2, "。", "PUNCT", "s,記号,句点,*", "punct", 0),
      ],
    };
    expect(isSentenceFinalParticleUse(last.tokens[1], last)).toBe(false);
    // …but a `discourse@sp` 乎 is the particle whatever else is true of it,
    // which is what keeps 不亦說乎 reading や — that test runs first.
    const rhetorical: Sentence = {
      tokens: [
        tok(0, "說", "VERB", "v,動詞,描写,態度", "ROOT", 0),
        { ...tok(1, "乎", "PART", SUFFIX_XPOS, "discourse@sp", 0) },
      ],
    };
    expect(isSentenceFinalParticleUse(rhetorical.tokens[1], rhetorical)).toBe(true);
    // …and a suffix-tagged 乎 with no stem to bind to keeps the particle
    // reading its position gave it before, since it renders no binom at all.
    const stemless: Sentence = {
      tokens: [tok(0, "嗟", "INTJ", "p,感嘆詞,*,*", "unk", 1), tok(1, "乎", "PART", SUFFIX_XPOS, "unk", 0)],
    };
    expect(isSentenceFinalParticleUse(stemless.tokens[1], stemless)).toBe(true);
  });


  it("finds the stem by source adjacency, not by the suffix's head edge", () => {
    // The reader's own 劉愕然: this parse hangs 然 off 劉, two tokens away,
    // rather than off the 愕 it suffixes. Reading back one token gets 愕; the
    // head edge gets the surname.
    const sentence: Sentence = {
      tokens: [
        tok(0, "劉", "PROPN", "n,名詞,人,姓氏", "subj", 5),
        tok(1, "愕", "VERB", "v,動詞,行為,態度", "flat", 0),
        tok(2, "然", "PART", SUFFIX_XPOS, "unk", 0),
      ],
    };
    expect(tariSuffixGroup(sentence.tokens[2], sentence)?.stem.text).toBe("愕");
    // …and answers from the stem's end too, so both members get one answer.
    expect(tariSuffixGroup(sentence.tokens[1], sentence)?.suffix.text).toBe("然");
    // The surname is neither.
    expect(tariSuffixGroup(sentence.tokens[0], sentence)).toBeNull();
  });

  it("takes the near half of a reduplication as the stem", () => {
    // 循循然, 望望然, 由由然: 56 of the 430 have their head further away than
    // one token, and in every one of them the token immediately before is the
    // second half of a `compound@redup`, which is still the stem.
    const sentence: Sentence = {
      tokens: [
        tok(0, "循", "ADV", "v,動詞,行為,動作", "mod", 2),
        tok(1, "循", "VERB", "v,動詞,行為,動作", "compound@redup", 0),
        tok(2, "然", "PART", SUFFIX_XPOS, "unk", 0),
      ],
    };
    expect(tariSuffixGroup(sentence.tokens[2], sentence)?.stem.id).toBe(1);
  });

  it("finds no group where a punctuation mark or nothing at all precedes", () => {
    const afterComma: Sentence = {
      tokens: [
        tok(0, "、", "PUNCT", "s,記号,読点,*", "punct", 2),
        tok(1, "然", "PART", SUFFIX_XPOS, "unk", 2),
        tok(2, "藏", "VERB", "v,動詞,行為,動作", "ROOT", 2),
      ],
    };
    expect(tariSuffixGroup(afterComma.tokens[1], afterComma)).toBeNull();
    const sentenceInitial: Sentence = { tokens: [tok(0, "然", "PART", SUFFIX_XPOS, "unk", 1), tok(1, "藏", "VERB", "v,動詞,行為,動作", "ROOT", 1)] };
    expect(tariSuffixGroup(sentenceInitial.tokens[0], sentenceInitial)).toBeNull();
  });

  it("moves the form question onto the stem, and only for the suffix", () => {
    const sentence: Sentence = {
      tokens: [
        tok(0, "愕", "VERB", "v,動詞,行為,態度", "mod", 2),
        tok(1, "然", "PART", SUFFIX_XPOS, "unk", 0),
        tok(2, "者", "PART", "p,助詞,提示,*", "ROOT", 2),
      ],
    };
    expect(conjugationSubject(sentence.tokens[1], sentence).text).toBe("愕");
    expect(conjugationSubject(sentence.tokens[0], sentence).text).toBe("愕");
    expect(conjugationSubject(sentence.tokens[2], sentence).text).toBe("者");
  });

  it("closes the VERB_LEXICON arm for a suffix, so 然 never falls back on ラ変 然り", () => {
    const suffix = tok(1, "然", "PART", SUFFIX_XPOS, "unk", 0);
    expect(lexiconEntryFor(suffix, {})).toBeUndefined();
    expect(lexiconEntryFor(suffix, { beatsLexicon: true, conjClass: "tari-keiyoudoushi", reading: "ぜん" })?.conjClass).toBe(
      "tari-keiyoudoushi",
    );
    // …while the standalone verb goes on reaching its own entry exactly as before.
    expect(lexiconEntryFor(tok(1, "然", "VERB", "v,動詞,描写,態度", "ROOT", 1), {})?.conjClass).toBe("ra-hen");
  });
});
