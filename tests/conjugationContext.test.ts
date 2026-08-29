import { describe, expect, it } from "vitest";
import type { Sentence, Token } from "../src/parse/types.ts";
import {
  caseParticleFor,
  decideConjForm,
  extraEndingFor,
  genitiveNoParticle,
  ziReading,
} from "../src/kakikudashi/conjugationContext.ts";
import { conjugate } from "../src/kakikudashi/classicalConjugation.ts";

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
